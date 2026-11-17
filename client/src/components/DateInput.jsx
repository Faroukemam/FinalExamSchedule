import { formatExamDateDisplay, normalizeExamDateForInput } from '../utils/date'

// A consistent day-first field with the browser calendar available alongside it.
export default function DateInput({ value = '', onChange, style, ...props }) {
    const iso = normalizeExamDateForInput(value)
    const change = next => onChange?.({ target: { name: props.name, value: normalizeExamDateForInput(next) || next } })
    return (
        <span className="date-input" style={style}>
            <input {...props} type="text" value={formatExamDateDisplay(value)}
                placeholder="DD/MM/YYYY" maxLength={10} inputMode="numeric"
                aria-label={props['aria-label'] || 'Date (DD/MM/YYYY)'}
                aria-invalid={Boolean(value && !iso)}
                onChange={event => change(event.target.value)} />
            <span className="date-input-calendar" aria-hidden="true">▦</span>
            <input className="date-input-picker" type="date" value={iso} lang="en-GB"
                aria-label="Choose date from calendar" disabled={props.disabled}
                onClick={event => event.currentTarget.showPicker?.()}
                onChange={event => change(event.target.value)} />
        </span>
    )
}
