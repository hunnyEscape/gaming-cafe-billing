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
		cardFingerprint?: string; // 追加: カードの一意識別子
		last4?: string;           // オプション: 下4桁（表示用）
		brand?: string;           // オプション: カードブランド（表示用
		paymentSetupCompleted?: boolean;
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