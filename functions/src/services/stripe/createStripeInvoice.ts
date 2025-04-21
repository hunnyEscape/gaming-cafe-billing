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

/** Firestore からデフォルトの PaymentMethod ID を引く */
const getDefaultPaymentMethodId = async (userId: string): Promise<string> => {
	const doc = await db.collection('users').doc(userId).get()
	if (!doc.exists) throw new Error(`User ${userId} not found`)
	const pm = doc.data()?.stripe?.paymentMethodId
	if (!pm) throw new Error(`User ${userId} has no default paymentMethodId`)
	return pm
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

/** メイン：ドラフト → 明細 → 確定 → 自動支払い → Firestore 更新 */
export const createStripeInvoiceForUser = async (
	invoiceData: InvoiceDocument,
	invoiceId: string
): Promise<string> => {
	try {
		// periodString を確定
		const periodString = invoiceData.periodString ?? '不明な月'

		// Stripe customer ID と default PM を取得
		const stripeCustomerId = await getStripeCustomerId(invoiceData.userId)
		const defaultPmId = await getDefaultPaymentMethodId(invoiceData.userId)

		// 1) ドラフト請求書作成（自動徴収モード & デフォルトPM指定）
		const draft = await getStripe().invoices.create({
			customer: stripeCustomerId,
			collection_method: 'charge_automatically',
			default_payment_method: defaultPmId,
			auto_advance: false,
			metadata: {
				firebaseInvoiceId: invoiceId,
				periodString
			},
			description: `利用料金 ${periodString}`
		})

		if (!draft.id) {
			throw new Error('Stripe invoice の ID が取得できませんでした')
		}
		const stripeInvoiceId = draft.id

		// 2) 明細を一件だけ作成
		await createInvoiceLineItemAggregate(
			stripeCustomerId,
			invoiceData,
			stripeInvoiceId
		)

		// 3) 確定（Finalize）
		const finalized = await retryStripeOperation(() =>
			getStripe().invoices.finalizeInvoice(stripeInvoiceId)
		)

		if (!finalized.id) {
			throw new Error('Stripe finalized invoice に ID がありません')
		}
		// 4) finalized.id をローカル変数に取り出して undefined を排除
		const finalInvoiceId = finalized.id
		if (!finalInvoiceId) {
			throw new Error('Stripe finalized invoice に ID がありません')
		}

		// 5) 自動支払いをトリガー
		await retryStripeOperation(() =>
			getStripe().invoices.pay(finalInvoiceId)  // ← ここに finalInvoiceId:string を渡す
		)

		// 5) Firestore 更新
		await db.collection('invoices').doc(invoiceId).update({
			status: 'pending',
			stripeInvoiceId: finalized.id,
			stripeInvoiceUrl: finalized.hosted_invoice_url,
			updatedAt: admin.firestore.FieldValue.serverTimestamp()
		})

		return finalized.id

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
