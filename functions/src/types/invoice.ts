import { Timestamp, FieldValue } from 'firebase-admin/firestore';

// Custom type to handle both Timestamp and string
export type TimestampOrString = Timestamp | string | FieldValue;

// 請求書ドキュメント
export interface InvoiceDocument {
	invoiceId: string;
	userId: string;
	userEmail: string;
	periodStart: TimestampOrString;
	periodEnd: TimestampOrString;
	periodString: string; // 'YYYY-MM'形式
	subtotalAmount: number;
	discountAmount: number;
	finalAmount: number;
	sessions: InvoiceSessionItem[];
	appliedCoupons: InvoiceAppliedCoupon[];
	status: 'pending_stripe' | 'pending' | 'paid' | 'failed';
	stripeInvoiceId?: string;
	stripeInvoiceUrl?: string;
	createdAt: TimestampOrString;
	paidAt?: TimestampOrString;
}

// 請求書に含まれるセッション項目
export interface InvoiceSessionItem {
	sessionId: string;
	startTime: TimestampOrString;
	endTime: TimestampOrString;
	hourBlocks: number;
	amount: number;
	seatId: string;
	seatName: string;
	branchName: string;
	blockchainTxId?: string;
}

// 適用されたクーポン情報
export interface InvoiceAppliedCoupon {
	couponId: string;
	code: string;
	name: string;
	discountValue: number;
}