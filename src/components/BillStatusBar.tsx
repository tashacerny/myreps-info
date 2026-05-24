import type { BillStatus } from '@/lib/types'

const STEPS: { key: BillStatus; label: string }[] = [
  { key: 'introduced', label: 'Introduced' },
  { key: 'passed-committee', label: 'Passed Committee' },
  { key: 'passed-house', label: 'Passed House' },
  { key: 'passed-senate', label: 'Passed Senate' },
  { key: 'signed', label: 'Signed into Law' },
]

const STATUS_INDEX: Record<BillStatus, number> = {
  introduced: 0,
  'passed-committee': 1,
  'passed-house': 2,
  'passed-senate': 3,
  signed: 4,
  vetoed: 4,
  failed: 4,
}

export default function BillStatusBar({ status }: { status: BillStatus }) {
  const currentIdx = STATUS_INDEX[status] ?? 0
  const isFailed = status === 'failed' || status === 'vetoed'

  return (
    <div className="flex items-center gap-0">
      {STEPS.map((step, idx) => {
        const isActive = idx <= currentIdx && !isFailed
        const isCurrent = idx === currentIdx
        const isLast = idx === STEPS.length - 1

        let label = step.label
        if (isCurrent && status === 'vetoed') label = 'Vetoed'
        if (isCurrent && status === 'failed') label = 'Failed'

        return (
          <div key={step.key} className="flex items-center flex-1 min-w-0">
            <div className="flex flex-col items-center flex-1 min-w-0">
              <div
                className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${
                  isActive
                    ? isFailed && isCurrent
                      ? 'bg-red-500 border-red-500'
                      : 'bg-civic-blue border-civic-blue'
                    : 'bg-white border-gray-300'
                }`}
              />
              <p
                className={`text-xs mt-1 text-center leading-tight ${
                  isActive ? 'text-civic-blue font-medium' : 'text-gray-400'
                }`}
              >
                {label}
              </p>
            </div>
            {!isLast && (
              <div
                className={`h-0.5 flex-1 mx-1 mb-4 ${
                  idx < currentIdx && !isFailed ? 'bg-civic-blue' : 'bg-gray-200'
                }`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
