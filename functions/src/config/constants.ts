export const COLLECTIONS = {
	USERS: 'users',
	SEATS: 'seats',
	SESSIONS: 'sessions',
	INVOICES: 'invoices',
};

export const SESSION_STATUS = {
	ACTIVE: 'active',
	COMPLETED: 'completed',
	ERROR: 'error'
};

export const SEAT_STATUS = {
	AVAILABLE: 'available',
	IN_USE: 'in-use',
	MAINTENANCE: 'maintenance'
};

export const BILLING_STATUS = {
	PENDING: 'pending',
	PROCESSING: 'processing',
	CONFIRMED: 'confirmed',
	ERROR: 'error'
};

export const CHAIN_CONFIG = {
	CHAIN_ID: '43114',
	NETWORK_ID: 1,
	RPC_ENDPOINT: 'https://api.avax.network/ext/bc/C/rpc'
};

// 請求書関連の定数
export const INVOICE_STATUS = {
	PENDING_STRIPE: 'pending_stripe',
	PENDING: 'pending',
	PAID: 'paid',
	FAILED: 'failed'
};
