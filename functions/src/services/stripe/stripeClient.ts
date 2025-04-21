import * as functions from 'firebase-functions/v1'
import Stripe from 'stripe'

/**
 * Stripe インスタンスの生成と再利用
 */
const getStripeInstance = (): Stripe => {
	const secretKey = functions.config().stripe?.secret_key
	if (!secretKey) {
		throw new Error(
			'Stripe secret key is not configured. ' +
			'Please run: firebase functions:config:set stripe.secret_key="sk_test_..."'
		)
	}
	return new Stripe(secretKey, {
		apiVersion: '2025-03-31.basil',
		typescript: true
	})
}

let stripeInstance: Stripe | null = null
export const getStripe = (): Stripe => {
	if (!stripeInstance) stripeInstance = getStripeInstance()
	return stripeInstance
}

/**
 * Stripe API エラー処理
 */
export const handleStripeError = (error: any, context: string): string => {
	console.error(`Stripe error in ${context}:`, error)
	if (error.type === 'StripeCardError') {
		return `支払い方法が拒否されました: ${error.message}`
	} else if (error.type === 'StripeInvalidRequestError') {
		return `無効なリクエスト: ${error.message}`
	} else if (error.type === 'StripeAPIError') {
		return 'Stripe APIエラー。しばらく経ってからもう一度お試しください。'
	} else if (error.type === 'StripeConnectionError') {
		return 'Stripeとの接続エラー。しばらく経ってからもう一度お試しください。'
	} else if (error.type === 'StripeAuthenticationError') {
		return 'システムエラーが発生しました。管理者にお問い合わせください。'
	}
	return '請求書の処理中にエラーが発生しました。'
}

/**
 * 一時的エラーなら再試行するヘルパー
 */
export const retryStripeOperation = async <T>(
	operation: () => Promise<T>,
	maxRetries = 3,
	delay = 1000
): Promise<T> => {
	let lastError: any
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await operation()
		} catch (error: any) {
			lastError = error
			const retryable =
				error.type === 'StripeConnectionError' ||
				error.type === 'StripeAPIError' ||
				(error.type === 'StripeInvalidRequestError' && error.code === 'rate_limit')
			if (retryable && attempt < maxRetries) {
				console.log(`Stripe retry ${attempt}/${maxRetries}, waiting ${delay}ms…`)
				await new Promise((r) => setTimeout(r, delay))
				delay *= 2
			} else {
				throw error
			}
		}
	}
	throw lastError
}
