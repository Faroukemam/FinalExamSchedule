function capForType(period, type) {
    const value = period[`${type}_cap`];
    return value === null || value === undefined || value === '' ? Infinity : Number(value);
}

// Each subject uses exactly one pool. Find the largest feasible Major subset,
// leaving the remaining whole subjects in Minor. Repacking avoids greedy traps.
function allocatePools(period, subjectCounts) {
    const subjects = Object.entries(subjectCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const total = subjects.reduce((sum, [, count]) => sum + count, 0);
    const majorCap = capForType(period, 'major');
    const minorCap = capForType(period, 'minor');
    const pools = {};
    if (total <= majorCap) {
        for (const [code] of subjects) pools[code] = 'major';
        return { ok: true, pools, usage: { major: total, minor: 0 } };
    }
    let best = -1;
    const reachable = new Map([[0, null]]);
    if (total <= majorCap + minorCap) {
        for (const [code, count] of subjects) {
            for (const [sum, node] of [...reachable]) {
                const next = sum + count;
                if (next <= majorCap && !reachable.has(next)) reachable.set(next, { code, previous: node });
            }
        }
        for (const sum of reachable.keys()) {
            if (total - sum <= minorCap && sum > best) best = sum;
        }
    }
    if (best >= 0) {
        for (const [code, count] of subjects) pools[code] = count === 0 ? 'major' : 'minor';
        for (let node = reachable.get(best); node; node = node.previous) pools[node.code] = 'major';
        return { ok: true, pools, usage: { major: best, minor: total - best } };
    }
    // Keep existing invalid schedules visible; never silently split a subject.
    const usage = { major: 0, minor: 0 };
    for (const [code, count] of subjects) {
        const pool = usage.major + count <= majorCap ? 'major'
            : usage.minor + count <= minorCap ? 'minor' : 'major';
        pools[code] = pool;
        usage[pool] += count;
    }
    return { ok: false, pools, usage };
}

module.exports = { capForType, allocatePools };
