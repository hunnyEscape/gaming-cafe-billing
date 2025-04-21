import * as admin from 'firebase-admin';
import { CouponDefinition, UserCoupon } from '../types/coupon';

// クーポン関連の操作を集約したサービス
export class CouponService {
	private db: FirebaseFirestore.Firestore;

	constructor() {
		this.db = admin.firestore();
	}

	// アクティブなクーポン定義を取得
	async getActiveCouponDefinitions(): Promise<CouponDefinition[]> {
		try {
			const query = this.db.collection('couponDefinitions')
				.where('isActive', '==', true);

			const snapshot = await query.get();

			if (snapshot.empty) {
				console.log('No active coupon definitions found');
				return [];
			}

			return snapshot.docs.map(doc => {
				return { id: doc.id, ...doc.data() } as CouponDefinition;
			});
		} catch (error) {
			console.error('Error fetching coupon definitions:', error);
			throw error;
		}
	}

	// ユーザーのクーポンを取得
	async getUserCoupons(userId: string): Promise<UserCoupon[]> {
		try {
			const query = this.db.collection('userCoupons')
				.where('userId', '==', userId)
				.where('status', '==', 'available');

			const snapshot = await query.get();

			return snapshot.docs.map(doc => {
				return { id: doc.id, ...doc.data() } as UserCoupon;
			});
		} catch (error) {
			console.error('Error fetching user coupons:', error);
			throw error;
		}
	}

	// ユーザーに新しいクーポンを発行
	async issueCouponToUser(userId: string, couponDefinition: CouponDefinition): Promise<UserCoupon> {
		try {
			const now = admin.firestore.Timestamp.now();

			// ユーザークーポンの作成
			const userCoupon: Omit<UserCoupon, 'id'> = {
				userId,
				name: couponDefinition.name,
				code: couponDefinition.code,
				description: couponDefinition.description,
				discountValue: couponDefinition.discountValue,
				status: 'available',
				issuedAt: now
			};

			// Firestoreに保存
			const docRef = await this.db.collection('userCoupons').add(userCoupon);

			console.log(`Coupon issued to user ${userId}: ${docRef.id}`);

			return {
				id: docRef.id,
				...userCoupon
			};
		} catch (error) {
			console.error('Error issuing coupon:', error);
			throw error;
		}
	}
}

// シングルトンインスタンスをエクスポート
export const couponService = new CouponService();