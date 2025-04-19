import { Timestamp } from 'firebase-admin/firestore';

export interface UserDocument {
	uid: string;
	email: string | null;
	displayName: string | null;
	photoURL: string | null;
	createdAt: Timestamp | string;
	lastLogin: Timestamp | string;
	registrationCompleted: boolean;
	registrationCompletedAt?: string;
	registrationStep?: number;
	// Stripe情報
	stripe?: {
		customerId?: string;
		paymentMethodId?: string;
		paymentSetupCompleted?: boolean;
		createdAt?: string;
		updatedAt?: string;
		paymentMethodType?: string;
		paymentMethodBrand?: string;
		paymentMethodLast4?: string;
		paymentStatus?: string;
		lastPaymentError?: string;
		lastPaymentErrorAt?: string;
	};
}

export interface SeatDocument {
	seatId: string;
	branchCode: string;
	branchName: string;
	seatType: string;
	seatNumber: number;
	name: string;
	ipAddress?: string;
	ratePerHour: number;
	status: 'available' | 'in-use' | 'maintenance';
	hourBlocks?: number;
	availableHours?: {
		[key: string]: string;
	};
	maxAdvanceBookingDays?: number;
	createdAt: Timestamp | string;
	updatedAt: Timestamp | string;
}


export interface SessionDocument {
	sessionId: string;
	userId: string;
	seatId: string;

	// JST で記録された Firestore Timestamp（UTC+9補正済）
	startTime: Timestamp | string;
	endTime: Timestamp | string;

	pricePerHour: number;
	active: boolean;
	duration: number;
	hourBlocks: number;

	// --- Blockchain 保存ステータス ---
	blockchainStatus: 'pending' | 'confirmed' | 'error';
	blockchainTxId: string | null;        // トランザクションハッシュ
	blockchainBlockNumber: number | null; // ブロック番号
	blockchainConfirmedAt: Timestamp | null; // 確定タイムスタンプ
	blockchainChainId: string | null;     // チェーン ID
	blockchainNetworkId: number | null;   // ネットワーク ID
	blockchainErrorMessage: string | null; // エラー詳細（任意）
}


export interface BillingProof {
	billingId: string;
	userId: string;
	sessionId: string;
	seatId: string;
	fileUrl: string;
	hash: string;
	chainId: string;
	networkId: number;
	txId: string | null;
	blockNumber: number | null;
	status: string;
	createdAt: Timestamp;
	confirmedAt: Timestamp | null;
}

export interface BillingQueueItem {
	sessionId: string;
	userId: string;
	seatId: string;
	status: string;
	createdAt: Timestamp;
	billingId?: string;
	hashValue?: string;
	updatedAt?: Timestamp;
	errorMessage?: string;
}