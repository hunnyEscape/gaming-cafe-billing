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

	// eKYC情報
	eKYC?: {
		sessionId?: string;
		status: string;
		verifiedAt?: string;
		lastUpdated?: string;
	};

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
	startTime: Timestamp | string;
	endTime: Timestamp | string;
	durationMinutes: number;
	amount: number;
	pricePerHour: number;
	active: boolean;
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