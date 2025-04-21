import * as admin from 'firebase-admin'
import { getStripe, retryStripeOperation, handleStripeError } from './stripeClient'
import { InvoiceDocument } from '../../types/invoice'

const db = admin.firestore()

/** Firestore から Stripe の Customer ID を引く */
const getStripeCustomerId = async (userId: string): Promise<string> => {
	const doc = await db.collection('users').doc(userId).get()
	if (!doc.exists) throw new Error(`User ${userId} not found`)
	const customerId = doc.data()?.stripe?.customerId
	if (!customerId) throw new Error(`User ${userId} has no stripe.customerId`)
	return customerId
}

/** 月間合計時間×単価−割引 をまとめて 1 件だけ作成 */
const createInvoiceLineItemAggregate = async (
	stripeCustomerId: string,
	invoiceData: InvoiceDocument,
	stripeInvoiceId: string
): Promise<void> => {
	const stripe = getStripe()

	const totalHours = invoiceData.sessions.reduce((sum, s) => sum + (s.hourBlocks ?? 0), 0)
	const totalAmount = invoiceData.sessions.reduce((sum, s) => sum + (s.hourBlocks ?? 0) * 600, 0)
	const net = Math.max(totalAmount - (invoiceData.discountAmount ?? 0), 0)
	const description = `利用料金 ${invoiceData.periodString ?? '不明な月'}：${totalHours}時間分`

	await retryStripeOperation(() =>
		stripe.invoiceItems.create({
			customer: stripeCustomerId,
			invoice: stripeInvoiceId,
			amount: net,
			currency: 'jpy',
			description,
			metadata: {
				totalHours: totalHours.toString(),
				discountAmount: (invoiceData.discountAmount ?? 0).toString()
			}
		})
	)
}

/** メイン：ドラフト → 明細 → 確定 → Firestore 更新 */
export const createStripeInvoiceForUser = async (
	invoiceData: InvoiceDocument,
	invoiceId: string
): Promise<string> => {
	try {
		// 型を明示的に絞る（非nullアサーションを避ける方法）
		const periodString = invoiceData.periodString ?? '不明な月'

		const stripeCust = await getStripeCustomerId(invoiceData.userId)

		const draft = await getStripe().invoices.create({
			customer: stripeCust,
			auto_advance: false,
			collection_method: 'charge_automatically',
			metadata: {
				firebaseInvoiceId: invoiceId,
				periodString
			},
			description: `利用料金 ${periodString}`
		})

		// Stripe の型が id?: string のため、ここで保証
		if (!draft.id) {
			throw new Error('Stripe invoice の ID が取得できませんでした')
		}
		const stripeInvoiceId: string = draft.id // ← ここで型が string に確定

		await createInvoiceLineItemAggregate(
			stripeCust,
			invoiceData,
			stripeInvoiceId
		)

		const finalized = await retryStripeOperation(() =>
			getStripe().invoices.finalizeInvoice(stripeInvoiceId)
		)

		await db.collection('invoices').doc(invoiceId).update({
			status: 'pending',
			stripeInvoiceId: finalized.id,
			stripeInvoiceUrl: finalized.hosted_invoice_url,
			updatedAt: admin.firestore.FieldValue.serverTimestamp()
		})

		const finalInvoiceId = finalized.id
		if (!finalInvoiceId) {
			throw new Error('Stripe finalized invoice に ID がありません')
		}
		return finalInvoiceId

	} catch (err) {
		const msg = handleStripeError(err, `createStripeInvoiceForUser:${invoiceId}`)
		await db.collection('invoices').doc(invoiceId).update({
			status: 'failed',
			errorMessage: msg,
			updatedAt: admin.firestore.FieldValue.serverTimestamp()
		})
		throw new Error(`Failed to create Stripe invoice: ${msg}`)
	}
}
