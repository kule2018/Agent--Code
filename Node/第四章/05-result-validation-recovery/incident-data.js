const incident = {
	serviceName: 'payment-service',
	window: {
		from: '2026-07-28T15:10:00+08:00',
		to: '2026-07-28T15:20:00+08:00'
	},
	primaryLogs: {
		errorCode: 'PAYMENT_CURRENCY_UNDEFINED',
		runtimeVersion: 'v2.4.1',
		firstSeenAt: '2026-07-28T15:10:08+08:00'
	},
	traceEvidence: {
		rootSpan: 'normalizeCurrency',
		errorCode: 'PAYMENT_CURRENCY_UNDEFINED',
		firstFailedAt: '2026-07-28T15:10:07+08:00'
	},
	inventory: {
		activeVersion: 'v2.4.0',
		checkedAt: '2026-07-28T15:18:00+08:00'
	}
}

module.exports = {
	incident
}
