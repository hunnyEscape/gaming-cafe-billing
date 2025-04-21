import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { getStripe, handleStripeError } from '../stripe/stripeClient';

// Firestoreへの参照
const db = admin.firestore();

/**
 * Stripe Webhookを処理するHTTP関数
 * 支払い状態の更新を処理します
 */
export const updateInvoiceStatus = functions.https.onRequest(async (req, res) => {
	const stripe = getStripe();

	try {
		// Webhookシークレットを環境変数から取得
		const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

		if (!webhookSecret) {
			console.error('Stripe webhook secret is not configured');
			res.status(500).send('Webhook Error: Missing webhook secret');
			return;
		}

		// リクエストからSignatureを取得
		const signature = req.headers['stripe-signature'];

		if (!signature) {
			console.error('No stripe signature in webhook request');
			res.status(400).send('Webhook Error: No Stripe signature');
			return;
		}

		// Stripeイベントを構築・検証
		const event = stripe.webhooks.constructEvent(
			req.rawBody,
			signature as string,
			webhookSecret
		);

		// イベントタイプに基づいて処理
		if (event.type === 'invoice.paid') {
			await handleInvoicePaid(event.data.object);
		} else if (event.type === 'invoice.payment_failed') {
			await handleInvoicePaymentFailed(event.data.object);
		} else {
			// 他のイベントタイプは無視
			console.log(`Unhandled Stripe event type: ${event.type}`);
		}

		// 正常応答
		res.status(200).send({ received: true });

	} catch (error) {
		// エラー処理
		const errorMessage = handleStripeError(error, 'updateInvoiceStatus webhook');
		console.error('Webhook Error:', errorMessage);
		res.status(400).send(`Webhook Error: ${errorMessage}`);
	}
});

/**
 * 支払い成功イベントを処理する関数
 */
const handleInvoicePaid = async (invoice: any): Promise<void> => {
	try {
		// Stripe請求書からFirestore請求書IDを取得
		const firebaseInvoiceId = invoice.metadata?.firebaseInvoiceId;

		if (!firebaseInvoiceId) {
			console.error('No Firebase invoice ID in Stripe invoice metadata', invoice.id);
			return;
		}

		console.log(`Processing paid event for Stripe invoice ${invoice.id} / Firebase invoice ${firebaseInvoiceId}`);

		// Firestore請求書を取得
		const invoiceRef = db.collection('invoices').doc(firebaseInvoiceId);
		const invoiceDoc = await invoiceRef.get();

		if (!invoiceDoc.exists) {
			console.error(`Firebase invoice ${firebaseInvoiceId} not found`);
			return;
		}

		// 請求書のステータスを更新
		await invoiceRef.update({
			status: 'paid',
			paidAt: admin.firestore.FieldValue.serverTimestamp(),
			updatedAt: admin.firestore.FieldValue.serverTimestamp()
		});

		console.log(`Successfully updated Firebase invoice ${firebaseInvoiceId} to paid status`);

	} catch (error) {
		console.error('Error handling invoice.paid event:', error);
		throw error;
	}
};

/**
 * 支払い失敗イベントを処理する関数
 */
const handleInvoicePaymentFailed = async (invoice: any): Promise<void> => {
	try {
		// Stripe請求書からFirestore請求書IDを取得
		const firebaseInvoiceId = invoice.metadata?.firebaseInvoiceId;

		if (!firebaseInvoiceId) {
			console.error('No Firebase invoice ID in Stripe invoice metadata', invoice.id);
			return;
		}

		console.log(`Processing payment_failed event for Stripe invoice ${invoice.id} / Firebase invoice ${firebaseInvoiceId}`);

		// Firestore請求書を取得
		const invoiceRef = db.collection('invoices').doc(firebaseInvoiceId);
		const invoiceDoc = await invoiceRef.get();

		if (!invoiceDoc.exists) {
			console.error(`Firebase invoice ${firebaseInvoiceId} not found`);
			return;
		}

		// 失敗理由を取得
		let failureMessage = '支払い処理に失敗しました。';
		if (invoice.last_payment_error) {
			failureMessage = `支払い失敗: ${invoice.last_payment_error.message}`;
		}

		// 請求書のステータスを更新
		await invoiceRef.update({
			status: 'failed',
			errorMessage: failureMessage,
			updatedAt: admin.firestore.FieldValue.serverTimestamp()
		});

		console.log(`Updated Firebase invoice ${firebaseInvoiceId} to failed status`);

	} catch (error) {
		console.error('Error handling invoice.payment_failed event:', error);
		throw error;
	}
};