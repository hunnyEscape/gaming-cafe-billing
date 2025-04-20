// src/services/coupons/issueNewUserCoupon.ts
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { couponService } from '../../services/couponService';
/**
 * ユーザーログイン時に初回クーポンを発行する関数
 * 既に初回クーポンを持っている場合は何もしない
 */
export const issueNewUserCoupon = onCall(
	{ region: 'asia-northeast1' },
	async (request) => {
		// 認証確認
		if (!request.auth) {
			throw new HttpsError(
				'unauthenticated',
				'ユーザー認証が必要です'
			);
		}

		const userId = request.auth.uid;
		console.log(`Checking if user ${userId} needs a new user coupon`);

		try {
			// ユーザーが既に初回クーポンを持っているか確認
			const existingCoupons = await couponService.getUserCoupons(userId, 'new_user');

			if (existingCoupons.length > 0) {
				console.log(`User ${userId} already has a new user coupon`);
				return { success: true, message: 'ユーザーは既に初回クーポンを持っています', couponExists: true };
			}

			// アクティブな初回クーポン定義を取得
			const couponDefinitions = await couponService.getActiveCouponDefinitions('new_user');

			if (couponDefinitions.length === 0) {
				console.log('No active new user coupon definitions found');
				return { success: false, message: '有効な初回クーポン定義が見つかりませんでした' };
			}

			// 優先度順にソート（数値が低いほど優先）
			const sortedDefinitions = couponDefinitions.sort((a, b) => a.priority - b.priority);
			const couponToIssue = sortedDefinitions[0];

			// クーポン発行
			const issuedCoupon = await couponService.issueCouponToUser(userId, couponToIssue);

			console.log(`New user coupon issued to user ${userId}: ${issuedCoupon.id}`);

			return {
				success: true,
				message: '初回クーポンが発行されました',
				coupon: issuedCoupon
			};
		} catch (error) {
			console.error('Error issuing new user coupon:', error);
			throw new HttpsError(
				'internal',
				'クーポン発行中にエラーが発生しました',
				error instanceof Error ? error.message : String(error)
			);
		}
	}
);