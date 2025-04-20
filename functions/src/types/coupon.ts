import { Timestamp, FieldValue } from 'firebase-admin/firestore';
export type TimestampOrString = Timestamp | string | FieldValue;

// クーポン定義（管理者が作成するマスターデータ）
export interface CouponDefinition {
    id: string;
    code: string;              // 管理用コード
    name: string;              // クーポン名
    description: string;       // 説明文
    discountType: 'fixed' | 'percentage';  // 固定額 or 割合
    discountValue: number;     // 割引額・割引率
    maxDiscount?: number;      // 最大割引額（割合の場合）
    minPurchase?: number;      // 最低利用金額
    issueTrigger: string;      // 発行トリガー（"new_user", "revisit", "multi_seat"など）
    validityPeriod: number;    // 有効期間（日数）- 発行日からの期間
    isActive: boolean;         // 有効/無効フラグ
    priority: number;          // 適用優先順位（低いほど優先）
    startDate: TimestampOrString; // キャンペーン開始日
    endDate: TimestampOrString;   // キャンペーン終了日
}

// ユーザークーポン（ユーザーに発行されたクーポン）
export interface UserCoupon {
    id?: string;
    userId: string;
    couponId: string;          // CouponDefinitionのID
    name: string;              // 表示用
    code: string;              // 表示用
    description: string;       // 表示用
    discountType: 'fixed' | 'percentage';
    discountValue: number;
    maxDiscount?: number;
    status: 'available' | 'used';  // 利用可能or使用済み
    issuedAt: TimestampOrString;   // 発行日
    validUntil: TimestampOrString; // 有効期限（発行日+有効期間）
    usedAt?: TimestampOrString;    // 使用日
    appliedMonthPeriod?: string;   // 適用された月（"2025-04"形式）
}

// 月次請求データの拡張
export interface MonthlyBilling {
    id?: string;
    userId: string;
    yearMonth: string;         // "2025-04"形式
    originalAmount: number;    // 割引前の合計金額
    appliedCoupons: {         // 適用されたクーポン情報
        userCouponId: string;
        couponId: string;
        name: string;
        discountAmount: number;
    }[];
    totalDiscountAmount: number; // 割引合計額
    finalAmount: number;        // 最終支払額
    isPaid: boolean;            // 支払い完了フラグ
    billingDate: TimestampOrString;  // 請求日
    paymentDate?: TimestampOrString; // 支払日
}