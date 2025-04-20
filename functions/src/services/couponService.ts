import * as admin from 'firebase-admin';
import { CouponDefinition, UserCoupon } from '../types/coupon';

// クーポン関連の操作を集約したサービス
export class CouponService {
    private db: FirebaseFirestore.Firestore;
    
    constructor() {
        this.db = admin.firestore();
    }
    
    // アクティブなクーポン定義を取得
    async getActiveCouponDefinitions(issueTrigger?: string): Promise<CouponDefinition[]> {
        try {
            let query = this.db.collection('couponDefinitions')
                .where('isActive', '==', true)
                .where('endDate', '>', admin.firestore.Timestamp.now());
                
            if (issueTrigger) {
                query = query.where('issueTrigger', '==', issueTrigger);
            }
            
            const snapshot = await query.get();
            
            if (snapshot.empty) {
                console.log(`No active coupon definitions found${issueTrigger ? ` for trigger: ${issueTrigger}` : ''}`);
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
    
    // ユーザーの特定タイプのクーポンを取得
    async getUserCoupons(userId: string, issueTrigger?: string): Promise<UserCoupon[]> {
        try {
            let query = this.db.collection('userCoupons')
                .where('userId', '==', userId)
                .where('status', '==', 'available')
                .where('validUntil', '>', admin.firestore.Timestamp.now());
                
            // タイプ指定がある場合、特定タイプのクーポンのIDを取得して絞り込む
            if (issueTrigger) {
                const couponDefs = await this.getActiveCouponDefinitions(issueTrigger);
                const couponIds = couponDefs.map(def => def.id);
                
                if (couponIds.length === 0) {
                    return []; // 該当するクーポン定義がない場合は早期リターン
                }
                
                // 配列フィルタリングは10要素までなのでチャンクに分割
                if (couponIds.length <= 10) {
                    query = query.where('couponId', 'in', couponIds);
                    const snapshot = await query.get();
                    return snapshot.docs.map(doc => {
                        return { id: doc.id, ...doc.data() } as UserCoupon;
                    });
                } else {
                    // 10要素以上の場合は複数クエリを実行
                    const chunks = this.chunkArray(couponIds, 10);
                    const results: UserCoupon[] = [];
                    
                    for (const chunk of chunks) {
                        const chunkQuery = this.db.collection('userCoupons')
                            .where('userId', '==', userId)
                            .where('status', '==', 'available')
                            .where('validUntil', '>', admin.firestore.Timestamp.now())
                            .where('couponId', 'in', chunk);
                            
                        const snapshot = await chunkQuery.get();
                        results.push(...snapshot.docs.map(doc => {
                            return { id: doc.id, ...doc.data() } as UserCoupon;
                        }));
                    }
                    
                    return results;
                }
            }
            
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
            
            // 有効期限の計算（発行日 + 有効期間日数）
            const validUntilDate = new Date(now.toMillis());
            validUntilDate.setDate(validUntilDate.getDate() + couponDefinition.validityPeriod);
            const validUntil = admin.firestore.Timestamp.fromDate(validUntilDate);
            
            // ユーザークーポンの作成
            const userCoupon: Omit<UserCoupon, 'id'> = {
                userId,
                couponId: couponDefinition.id,
                name: couponDefinition.name,
                code: couponDefinition.code,
                description: couponDefinition.description,
                discountType: couponDefinition.discountType,
                discountValue: couponDefinition.discountValue,
                maxDiscount: couponDefinition.maxDiscount,
                status: 'available',
                issuedAt: now,
                validUntil
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
    
    // 配列をチャンクに分割するユーティリティ
    private chunkArray<T>(array: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }
}

// シングルトンインスタンスをエクスポート
export const couponService = new CouponService();