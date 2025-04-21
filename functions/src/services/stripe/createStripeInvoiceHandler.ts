import * as functions from 'firebase-functions/v1';
import { InvoiceDocument } from '../../types/invoice';
import { createStripeInvoiceForUser } from './createStripeInvoice';

// Firestoreへの参照

/**
 * Firestoreトリガーで請求書のステータスが 'pending_stripe' の場合に、
 * Stripe請求書を作成するCloud Function
 */
export const createStripeInvoiceHandler = functions.firestore
	.document('invoices/{invoiceId}')
	.onWrite(async (change, context) => {
		// ドキュメントが削除された場合は何もしない
		if (!change.after.exists) {
			console.log('Document was deleted, no action required');
			return null;
		}

		const invoiceData = change.after.data() as InvoiceDocument;
		const invoiceId = context.params.invoiceId;

		// 'pending_stripe' ステータスの請求書のみ処理
		if (invoiceData.status !== 'pending_stripe') {
			console.log(`Invoice ${invoiceId} status is ${invoiceData.status}, skipping Stripe invoice creation`);
			return null;
		}

		try {
			console.log(`Processing invoice ${invoiceId} for user ${invoiceData.userId}`);

			// Stripe請求書を作成
			await createStripeInvoiceForUser(invoiceData, invoiceId);

			return { success: true };
		} catch (error) {
			console.error(`Failed to process invoice ${invoiceId}:`, error);

			return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
		}
	});