import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { InvoiceAppliedCoupon } from '../../types/invoice';
import { UserCoupon } from '../../types/coupon';

/**
 * ユーザーのクーポンを請求金額に適用する
 * 
 * @param userId ユーザーID
 * @param totalAmount 請求総額
 * @param periodString 適用月（YYYY-MM形式）
 * @returns 適用されたクーポンと合計割引額
 */
export const applyCoupons = async (
  userId: string,
  totalAmount: number,
  periodString: string
): Promise<{
  appliedCoupons: InvoiceAppliedCoupon[];
  totalDiscountAmount: number;
}> => {
  const db = admin.firestore();
  
  try {
    // 利用可能なクーポンを割引額の大きい順に取得
    const couponsQuery = await db.collection('userCoupons')
      .where('userId', '==', userId)
      .where('status', '==', 'available')
      .orderBy('discountValue', 'desc')
      .get();

    if (couponsQuery.empty) {
      return { appliedCoupons: [], totalDiscountAmount: 0 };
    }

    const appliedCoupons: InvoiceAppliedCoupon[] = [];
    let remainingAmount = totalAmount;
    let totalDiscountAmount = 0;
    
    // バッチ処理の準備
    const batch = db.batch();

    // クーポンを順番に適用
    for (const couponDoc of couponsQuery.docs) {
      // 残額がなくなったら終了
      if (remainingAmount <= 0) break;

      const couponData = couponDoc.data() as UserCoupon;
      
      // 適用する割引額（残額より大きい場合は残額まで）
      const discountToApply = Math.min(couponData.discountValue, remainingAmount);
      
      // クーポンを適用
      appliedCoupons.push({
        couponId: couponDoc.id,
        code: couponData.code,
        name: couponData.name,
        discountValue: discountToApply
      });
      
      // クーポンのステータスを更新
      batch.update(couponDoc.ref, {
        status: 'used',
        appliedMonthPeriod: periodString,
        updatedAt: admin.firestore.Timestamp.now()
      });
      
      // 残額と割引合計を更新
      remainingAmount -= discountToApply;
      totalDiscountAmount += discountToApply;
    }
    
    // バッチ処理を実行（適用したクーポンがある場合のみ）
    if (appliedCoupons.length > 0) {
      await batch.commit();
      functions.logger.info(`Applied ${appliedCoupons.length} coupons for user ${userId}, total discount: ${totalDiscountAmount} JPY`);
    }
    
    return { appliedCoupons, totalDiscountAmount };
  } catch (error) {
    functions.logger.error(`Error applying coupons for user ${userId}:`, error);
    // エラー時は割引なしで続行
    return { appliedCoupons: [], totalDiscountAmount: 0 };
  }
};