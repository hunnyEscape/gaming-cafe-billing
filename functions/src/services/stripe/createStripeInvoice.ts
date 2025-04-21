import * as admin from 'firebase-admin';
import { getStripe, retryStripeOperation, handleStripeError } from './stripeClient';
import { InvoiceDocument } from '../../types/invoice';

// Firestoreへの参照
const db = admin.firestore();

/**
 * Stripe請求書を作成する関数
 * @param invoiceData Firestore上の請求書データ
 * @param invoiceId 請求書ID
 */
export const createStripeInvoiceForUser = async (
	invoiceData: InvoiceDocument,
	invoiceId: string
): Promise<string> => {
	try {
		console.log(`Creating Stripe invoice for Firebase invoice ${invoiceId} (User: ${invoiceData.userId})`);

		// 1. ユーザーのStripe顧客IDを取得
		const stripeCustomerId = await getStripeCustomerId(invoiceData.userId);

		// 2. Stripeの請求書アイテムを作成
		await createInvoiceLineItems(stripeCustomerId, invoiceData);

		// 3. Stripe請求書を作成して確定
		const stripeInvoice = await createAndFinalizeInvoice(
			stripeCustomerId,
			invoiceId,
			invoiceData.periodString
		);

		// 4. Firestoreの請求書ステータスを更新
		await db.collection('invoices').doc(invoiceId).update({
			status: 'pending',
			stripeInvoiceId: stripeInvoice.id,
			stripeInvoiceUrl: stripeInvoice.hosted_invoice_url,
			updatedAt: admin.firestore.FieldValue.serverTimestamp()
		});

		console.log(`Successfully created Stripe invoice ${stripeInvoice.id} for Firebase invoice ${invoiceId}`);
		return stripeInvoice.id;

	} catch (error) {
		const errorMessage = handleStripeError(error, `createStripeInvoice:${invoiceId}`);

		// エラー時にInvoiceステータスを更新
		await db.collection('invoices').doc(invoiceId).update({
			status: 'failed',
			errorMessage: errorMessage,
			updatedAt: admin.firestore.FieldValue.serverTimestamp()
		});

		throw new Error(`Failed to create Stripe invoice: ${errorMessage}`);
	}
};

/**
 * ユーザーのStripe顧客IDを取得する関数
 * DB構造に合わせて修正
 */
const getStripeCustomerId = async (userId: string): Promise<string> => {
	const userDoc = await db.collection('users').doc(userId).get();

	if (!userDoc.exists) {
		throw new Error(`User ${userId} not found`);
	}

	const userData = userDoc.data();

	// stripe.customerIdフィールドを確認（ネストされた構造）
	const stripeCustomerId = userData?.stripe?.customerId;

	if (!stripeCustomerId) {
		throw new Error(`User ${userId} does not have a Stripe customer ID`);
	}

	console.log(`Found Stripe customer ID for user ${userId}: ${stripeCustomerId}`);
	return stripeCustomerId;
};

/**
 * 請求書の明細項目を作成する関数
 */
const createInvoiceLineItems = async (
	stripeCustomerId: string,
	invoiceData: InvoiceDocument
): Promise<void> => {
	const stripe = getStripe();

	// セッションごとに明細項目を作成
	for (const session of invoiceData.sessions) {
		// 日時のフォーマット
		const startTime = formatTimestamp(session.startTime);
		const endTime = formatTimestamp(session.endTime);

		// 明細の説明文
		const description = `${session.branchName} - ${session.seatName} (${startTime}～${endTime})`;

		// 明細項目を作成
		await retryStripeOperation(() =>
			stripe.invoiceItems.create({
				customer: stripeCustomerId,
				amount: session.amount,
				currency: 'jpy',
				description: description,
				metadata: {
					sessionId: session.sessionId,
					hourBlocks: session.hourBlocks.toString(),
					seatId: session.seatId
				}
			})
		);
	}

	// クーポン割引がある場合は割引項目を追加
	if (invoiceData.discountAmount > 0 && invoiceData.appliedCoupons?.length > 0) {
		// クーポンコードをカンマ区切りで連結
		const couponCodes = invoiceData.appliedCoupons
			.map(coupon => coupon.code)
			.join(', ');

		// 割引項目を作成（マイナス値）
		await retryStripeOperation(() =>
			stripe.invoiceItems.create({
				customer: stripeCustomerId,
				amount: -invoiceData.discountAmount, // マイナス値にして割引として表示
				currency: 'jpy',
				description: `クーポン割引 (${couponCodes})`
			})
		);
	}
};

/**
 * Stripe請求書を作成して確定する関数
 */
const createAndFinalizeInvoice = async (
	stripeCustomerId: string,
	invoiceId: string,
	periodString: string
): Promise<any> => {
	const stripe = getStripe();

	// 請求書を作成
	const invoice = await retryStripeOperation(() =>
		stripe.invoices.create({
			customer: stripeCustomerId,
			collection_method: 'charge_automatically',
			auto_advance: true,
			metadata: {
				firebaseInvoiceId: invoiceId,
				periodString: periodString
			},
			description: `利用料金 ${periodString}`
		})
	);

	// invoice.id が存在することを確認
	if (!invoice.id) {
		throw new Error('Failed to create Stripe invoice: No invoice ID returned');
	}

	const stripeInvoiceId = invoice.id as string;

	// 請求書を確定
	return await retryStripeOperation(() =>
		stripe.invoices.finalizeInvoice(stripeInvoiceId)
	);
};

/**
 * TimestampをJST形式の文字列に変換する関数
 */
const formatTimestamp = (timestamp: any): string => {
	if (timestamp instanceof admin.firestore.Timestamp) {
		const date = timestamp.toDate();
		return `${date.toLocaleDateString('ja-JP')} ${date.toLocaleTimeString('ja-JP')}`;
	} else if (typeof timestamp === 'string') {
		return new Date(timestamp).toLocaleString('ja-JP');
	}
	return 'Unknown time';
};