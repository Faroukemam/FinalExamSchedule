export default function CapacityInputs({ value, onChange, fieldsToApply, onFieldsToApplyChange }) {
    return (
        <div className="capacity-inputs">
            {['major', 'minor', 'subject'].map(type => (
                <div key={type} className="capacity-field">
                    <label className="text-sm">
                        {fieldsToApply && <input type="checkbox" checked={!!fieldsToApply[type]}
                            onChange={e => onFieldsToApplyChange({ ...fieldsToApply, [type]: e.target.checked })} />}{' '}
                        {type === 'subject' ? 'Max students per subject' : `${type === 'major' ? 'Major' : 'Minor'} cap`}
                    </label>
                    <input className="form-input" type="number" min="0" step="1" placeholder="Unlimited"
                        aria-label={type === 'subject' ? 'Max students per subject' : `${type === 'major' ? 'Major' : 'Minor'} cap`}
                        disabled={fieldsToApply && !fieldsToApply[type]}
                        value={value[`${type}_cap`] ?? ''}
                        onChange={e => onChange({ ...value, [`${type}_cap`]: e.target.value })} />
                </div>
            ))}
        </div>
    )
}

export function CapacitySummary({ value, usage }) {
    return (
        <div style={{ display: 'grid', gap: 4 }}>
            {['major', 'minor'].map(type => (
                <span key={type} className="text-sm">
                    {type === 'major' ? 'Major' : 'Minor'}: {usage ? `${usage[type] || 0} / ` : ''}{value[`${type}_cap`] ?? 'Unlimited'}
                </span>
            ))}
            <span className="text-sm">Per subject: {value.subject_cap ?? 'Unlimited'}</span>
        </div>
    )
}
