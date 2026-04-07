import json
import sys
from collections import defaultdict

from ortools.sat.python import cp_model


OBJECTIVE_SCALES = {
    "same_period": 1_000_000_000,
    "overlapping": 10_000_000,
    "capacity_overflow": 1_000_000,
    "back_to_back": 100_000,
    "same_day": 1_000,
    "consecutive_day": 10,
    "earlier_large_subject": 50,
    "utilization": 1,
}


def to_minutes(time_value):
    hh, mm = str(time_value or "00:00").split(":")
    return (int(hh) * 60) + int(mm)


def period_duration_minutes(period):
    diff = to_minutes(period["end_time"]) - to_minutes(period["start_time"])
    if diff < 0:
        diff += 24 * 60
    return diff


def periods_overlap(a, b):
    return to_minutes(a["start_time"]) < to_minutes(b["end_time"]) and to_minutes(b["start_time"]) < to_minutes(a["end_time"])


def periods_back_to_back(a, b):
    return to_minutes(a["end_time"]) == to_minutes(b["start_time"]) or to_minutes(b["end_time"]) == to_minutes(a["start_time"])


def day_diff(a_date, b_date):
    from datetime import date

    ay, am, ad = [int(part) for part in str(a_date).split("-")]
    by, bm, bd = [int(part) for part in str(b_date).split("-")]
    return abs((date(ay, am, ad) - date(by, bm, bd)).days)


def pair_key(a, b):
    return tuple(sorted((a, b)))


def relation_breakdown(a, b, back_to_back_mode):
    a_id = int(a.get("id", a.get("period_id")))
    b_id = int(b.get("id", b.get("period_id")))
    breakdown = {
        "same_period": 0,
        "overlapping": 0,
        "back_to_back": 0,
        "same_day": 0,
        "consecutive_day": 0,
    }
    if a_id == b_id:
        breakdown["same_period"] = 1
        return breakdown
    if a["exam_date"] == b["exam_date"]:
        if periods_overlap(a, b):
            breakdown["overlapping"] = 1
            return breakdown
        if back_to_back_mode != "allowed" and periods_back_to_back(a, b):
            breakdown["back_to_back"] = 1
        breakdown["same_day"] = 1
        return breakdown
    if day_diff(a["exam_date"], b["exam_date"]) == 1:
        breakdown["consecutive_day"] = 1
    return breakdown


def build_shared_counts(registrations):
    student_subjects = defaultdict(set)
    for row in registrations:
        student_subjects[str(row["student_id"])].add(str(row["subject_code"]))

    shared = defaultdict(int)
    for subjects in student_subjects.values():
        subjects = sorted(subjects)
        for i in range(len(subjects)):
            for j in range(i + 1, len(subjects)):
                shared[pair_key(subjects[i], subjects[j])] += 1
    return shared


def solve(payload):
    unscheduled = payload.get("unscheduled", [])
    units = payload.get("units") or []
    periods = payload["periods"]
    current_schedule = payload["current_schedule"]
    registrations = payload["registrations"]
    back_to_back_mode = payload.get("back_to_back_mode", "warning")

    if not periods:
        return {
            "ok": False,
            "error": "No exam periods defined",
            "placed": [],
            "failed": [],
        }

    period_by_id = {int(p["id"]): p for p in periods}
    periods_by_date = defaultdict(list)
    for period in periods:
        periods_by_date[period["exam_date"]].append(period)
    ordered_dates = sorted({str(period["exam_date"]) for period in periods})
    day_rank_by_date = {exam_date: index for index, exam_date in enumerate(ordered_dates)}

    def normalized_cap(period):
        raw = period.get("student_cap")
        if raw in (None, ""):
            return None
        cap = int(raw)
        return cap if cap > 0 else None

    shared_counts = build_shared_counts(registrations)

    existing_students_by_period = defaultdict(int)
    for row in current_schedule:
        existing_students_by_period[int(row["period_id"])] += int(row.get("student_count") or 0)

    current_students_by_period_subject = {}
    for row in current_schedule:
        current_students_by_period_subject[(int(row["period_id"]), str(row["subject_code"]))] = {
            str(student_id) for student_id in row.get("assigned_student_ids") or []
        }

    existing_exam_count_by_student_day = defaultdict(int)
    for row in current_schedule:
        exam_date = str(row["exam_date"])
        for student_id in row.get("assigned_student_ids") or []:
            existing_exam_count_by_student_day[(str(student_id), exam_date)] += 1

    schedulable = []
    failed = []
    if units:
        for unit in units:
            schedulable.append({
                "unit_id": str(unit["unit_id"]),
                "subject_codes": [str(code) for code in unit.get("subject_codes", [])],
                "required_duration": int(unit.get("required_duration") or 120),
                "student_count": int(unit.get("student_count") or 0),
                "eligible_period_ids": [int(period_id) for period_id in unit.get("eligible_period_ids", [])],
                "enrolled_students": [str(student_id) for student_id in unit.get("enrolled_students", [])],
            })
    else:
        for subject in unscheduled:
            subject_code = str(subject["subject_code"])
            required_duration = int(subject.get("exam_duration") or 120)
            eligible = [
                int(period["id"])
                for period in periods
                if period_duration_minutes(period) == required_duration
            ]
            if not eligible:
                failed.append({
                    "subject_code": subject_code,
                    "reason": f"No period matches exact required duration ({required_duration} min)",
                })
                continue
            schedulable.append({
                "unit_id": f"subject-{subject_code}",
                "subject_codes": [subject_code],
                "required_duration": required_duration,
                "student_count": int(subject.get("student_count") or 0),
                "eligible_period_ids": eligible,
                "enrolled_students": [],
            })

    if not schedulable:
        return {"ok": True, "placed": [], "failed": failed}

    model = cp_model.CpModel()
    objective_terms = {key: [] for key in OBJECTIVE_SCALES.keys()}
    x = {}

    for subject in schedulable:
        vars_for_subject = []
        for period_id in subject["eligible_period_ids"]:
            var = model.NewBoolVar(f"x_{subject['unit_id']}_{period_id}")
            x[(subject["unit_id"], period_id)] = var
            vars_for_subject.append(var)
        model.Add(sum(vars_for_subject) == 1)

    vars_by_student_day = defaultdict(list)
    for subject in schedulable:
        enrolled_students = [str(student_id) for student_id in subject.get("enrolled_students") or []]
        if not enrolled_students:
            continue
        for period_id in subject["eligible_period_ids"]:
            period = period_by_id[period_id]
            exam_date = str(period["exam_date"])
            var = x[(subject["unit_id"], period_id)]
            for student_id in enrolled_students:
                vars_by_student_day[(student_id, exam_date)].append(var)

    for (student_id, exam_date), vars_for_day in vars_by_student_day.items():
        existing_count = existing_exam_count_by_student_day.get((student_id, exam_date), 0)
        max_new = max(0, 2 - existing_count)
        model.Add(sum(vars_for_day) <= max_new)

    for period in periods:
        cap = normalized_cap(period)
        if cap is None:
            continue
        period_id = int(period["id"])
        existing_students = existing_students_by_period.get(period_id, 0)
        eligible_vars = [
            subject["student_count"] * x[(subject["unit_id"], period_id)]
            for subject in schedulable
            if (subject["unit_id"], period_id) in x
        ]
        if eligible_vars:
            max_allowed = int(cap)
            if existing_students >= max_allowed:
                for subject in schedulable:
                    if (subject["unit_id"], period_id) in x:
                        model.Add(x[(subject["unit_id"], period_id)] == 0)
                continue
            model.Add(existing_students + sum(eligible_vars) <= max_allowed)
            max_possible = existing_students + sum(subject["student_count"] for subject in schedulable if (subject["unit_id"], period_id) in x)
            overflow = model.NewIntVar(0, max_possible, f"overflow_{period_id}")
            model.Add(existing_students + sum(eligible_vars) - cap <= overflow)
            objective_terms["capacity_overflow"].append(overflow)

    for subject in schedulable:
        subject_codes = subject["subject_codes"]
        for period_id in subject["eligible_period_ids"]:
            period = period_by_id[period_id]
            fixed_breakdown = {
                "same_period": 0,
                "overlapping": 0,
                "back_to_back": 0,
                "same_day": 0,
                "consecutive_day": 0,
            }
            for existing in current_schedule:
                breakdown = relation_breakdown(period, existing, back_to_back_mode)
                existing_students = current_students_by_period_subject.get(
                    (int(existing["period_id"]), str(existing["subject_code"])),
                    set(),
                )
                overlap = len(existing_students.intersection(set(subject.get("enrolled_students", []))))
                if overlap <= 0:
                    continue
                for key, value in breakdown.items():
                    fixed_breakdown[key] += overlap * value
            for key, value in fixed_breakdown.items():
                if value:
                    objective_terms[key].append(value * x[(subject["unit_id"], period_id)])

            size_bucket = max(1, (int(subject["student_count"]) + 24) // 25)
            day_rank = day_rank_by_date.get(str(period["exam_date"]), 0)
            objective_terms["earlier_large_subject"].append(day_rank * size_bucket * x[(subject["unit_id"], period_id)])

            existing_students = existing_students_by_period.get(period_id, 0)
            objective_terms["utilization"].append((existing_students + subject["student_count"]) * x[(subject["unit_id"], period_id)])

    for i in range(len(schedulable)):
        left = schedulable[i]
        for j in range(i + 1, len(schedulable)):
            right = schedulable[j]
            overlap = sum(
                shared_counts[pair_key(left_code, right_code)]
                for left_code in left["subject_codes"]
                for right_code in right["subject_codes"]
                if left_code != right_code
            )
            if overlap <= 0:
                continue

            for left_pid in left["eligible_period_ids"]:
                for right_pid in right["eligible_period_ids"]:
                    breakdown = relation_breakdown(period_by_id[left_pid], period_by_id[right_pid], back_to_back_mode)
                    if not any(breakdown.values()):
                        continue
                    linked = model.NewBoolVar(
                        f"rel_{left['unit_id']}_{right['unit_id']}_{left_pid}_{right_pid}"
                    )
                    model.Add(linked <= x[(left["unit_id"], left_pid)])
                    model.Add(linked <= x[(right["unit_id"], right_pid)])
                    model.Add(
                        linked
                        >= x[(left["unit_id"], left_pid)] + x[(right["unit_id"], right_pid)] - 1
                    )
                    for key, value in breakdown.items():
                        if value:
                            objective_terms[key].append(overlap * value * linked)

    scaled_terms = []
    for key, scale in OBJECTIVE_SCALES.items():
        if objective_terms[key]:
            scaled_terms.append(scale * sum(objective_terms[key]))
    model.Minimize(sum(scaled_terms) if scaled_terms else 0)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 20
    solver.parameters.num_search_workers = 8

    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {
            "ok": False,
            "error": "OR-Tools could not find a feasible schedule",
            "placed": [],
            "failed": failed,
        }

    placed = []
    for subject in schedulable:
        chosen_period_id = None
        for period_id in subject["eligible_period_ids"]:
            if solver.Value(x[(subject["unit_id"], period_id)]) == 1:
                chosen_period_id = period_id
                break
        if chosen_period_id is None:
            failed.append({
                "subject_codes": subject["subject_codes"],
                "reason": "Solver returned no period",
            })
            continue
        chosen_period = period_by_id[chosen_period_id]
        placed.append({
            "subject_codes": subject["subject_codes"],
            "exam_period_id": chosen_period_id,
            "required_duration": subject["required_duration"],
            "period": f"{chosen_period['exam_date']} {chosen_period['start_time']}-{chosen_period['end_time']}",
        })

    return {"ok": True, "placed": placed, "failed": failed}


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    result = solve(payload)
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
