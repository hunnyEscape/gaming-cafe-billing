// src/services/coupons/issueNewUserCoupon.ts
import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';

/**
 * ユーザーが新規作成された時に初回クーポンを自動発行する
 */
export const issueNewUserCoupon = functions.firestore
	.document('users/{userId}')
	.onCreate(async (snapshot, context) => {
		const userId = context.params.userId;
		console.log(`New user created: ${userId}, issuing initial coupon`);

		try {
			// 1) すでに利用可能なクーポンを持っていないかチェック
			const existing = await admin.firestore()
				.collection('userCoupons')
				.where('userId', '==', userId)
				.where('status', '==', 'available')
				.limit(1)
				.get();

			if (!existing.empty) {
				console.log(`User ${userId} already has an available coupon`);
				return { success: true, message: 'ユーザーはすでにクーポンを持っています', couponExists: true };
			}

			// 2) “WELCOME” 定義を直接取得
			const defDoc = await admin.firestore()
				.collection('couponDefinitions')
				.doc('WELCOME')
				.get();

			if (!defDoc.exists) {
				console.error('WELCOME 定義が見つかりません');
				return { success: false, message: 'クーポン定義がありません' };
			}

			const def = defDoc.data()!;
			// 3) 発行レコードを組み立て
			const now = admin.firestore.Timestamp.now();
			const userCoupon = {
				userId,
				name: def.name,
				code: def.code,
				description: def.description,
				discountValue: def.discountValue,
				status: 'available' as const,
				issuedAt: now,
				// validityPeriod が空文字の場合は有効期限未設定
				// 必要であれば expiresAt フィールドも追加できます
			};

			// 4) Firestore に保存
			const docRef = await admin.firestore()
				.collection('userCoupons')
				.add(userCoupon);

			console.log(`Issued WELCOME coupon to ${userId}, couponId=${docRef.id}`);
			return {
				success: true,
				message: 'クーポンが発行されました',
				coupon: { id: docRef.id, ...userCoupon }
			};

		} catch (error) {
			console.error('Error issuing coupon:', error);
			throw error;
		}
	});
