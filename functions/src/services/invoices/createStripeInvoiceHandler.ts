import * as functions from 'firebase-functions/v1'
import { InvoiceDocument } from '../../types/invoice'
import { createStripeInvoiceForUser } from '../stripe/createStripeInvoice'

/**
 * Firestore トリガー：invoices/{invoiceId}
 * status が "pending_stripe" になったら実行
 */
export const createStripeInvoiceHandler = functions.firestore
	.document('invoices/{invoiceId}')
	.onWrite(async (change, context) => {
		// 削除時は何もしない
		if (!change.after.exists) return null

		const data = change.after.data() as InvoiceDocument
		const id = context.params.invoiceId

		if (data.status !== 'pending_stripe') {
			console.log(`Skipping invoice ${id}, status=${data.status}`)
			return null
		}

		try {
			console.log(`Triggering Stripe invoice for ${id}`)
			await createStripeInvoiceForUser(data, id)
			return { success: true }
		} catch (e: any) {
			console.error(`Error in handler for ${id}:`, e)
			return { success: false, error: e.message || e }
		}
	})
