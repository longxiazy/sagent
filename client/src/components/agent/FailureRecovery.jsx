import { AlertTriangle, RefreshCw } from 'lucide-react';

export function FailureRecovery({ category, recovery, t }) {
  if (!category && !recovery) return null;
  return (
    <div className="failure-recovery">
      {category && (
        <span className="failure-recovery-category">
          <AlertTriangle size={11} />
          {t('failure.categoryLabel')}: {t(`failure.category.${category}`)}
        </span>
      )}
      {recovery && (
        <span className="failure-recovery-action">
          <RefreshCw size={11} />
          {t('failure.recoveryLabel')}: {t(`failure.recovery.${recovery}`)}
        </span>
      )}
    </div>
  );
}
