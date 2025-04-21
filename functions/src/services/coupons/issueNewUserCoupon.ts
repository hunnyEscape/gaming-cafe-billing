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
		console.log(`New user created: ${userId}, checking for coupon eligibility`);

		try {
			// ユーザーが既に初回クーポンを持っているか確認
			const existingCouponsQuery = await admin.firestore()
				.collection('userCoupons')
				.where('userId', '==', userId)
				.where('status', '==', 'available')
				.get();

			if (!existingCouponsQuery.empty) {
				console.log(`User ${userId} already has a coupon`);
				return { success: true, message: 'ユーザーは既にクーポンを持っています', couponExists: true };
			}

			// クーポン定義を取得
			const couponDefinitionsQuery = await admin.firestore()
				.collection('couponDefinitions')
				.where('isActive', '==', true)
				.get();

			if (couponDefinitionsQuery.empty) {
				console.log('No active coupon definitions found');
				return { success: false, message: '有効なクーポン定義が見つかりませんでした' };
			}

			// クーポン定義を配列に変換
			const couponDefinitions = couponDefinitionsQuery.docs.map(doc => {
				const data = doc.data();
				return {
					id: doc.id,
					code: data.code,
					name: data.name,
					description: data.description,
					discountValue: data.discountValue,
					validityPeriod: data.validityPeriod,
					isActive: data.isActive
				};
			});

			// 最初のクーポン定義を使用
			const couponToIssue = couponDefinitions[0];

			// クーポン発行
			const now = admin.firestore.Timestamp.now();

			// ユーザークーポンの作成
			const userCoupon = {
				userId,
				name: couponToIssue.name,
				code: couponToIssue.code,
				description: couponToIssue.description,
				discountValue: couponToIssue.discountValue,
				status: 'available',
				issuedAt: now
			};

			// Firestoreに保存
			const docRef = await admin.firestore().collection('userCoupons').add(userCoupon);

			const issuedCoupon = {
				id: docRef.id,
				...userCoupon
			};

			console.log(`Coupon issued to user ${userId}: ${issuedCoupon.id}`);

			return {
				success: true,
				message: 'クーポンが発行されました',
				coupon: issuedCoupon
			};
		} catch (error) {
			console.error('Error issuing coupon:', error);
			throw error;
		}
	});