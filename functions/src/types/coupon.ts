import { Timestamp, FieldValue } from 'firebase-admin/firestore';
export type TimestampOrString = Timestamp | string | FieldValue;

// クーポン定義（管理者が作成するマスターデータ）
export interface CouponDefinition {
	id: string;
    code: string;              // 管理用コード
    name: string;              // クーポン名
    description: string;       // 説明文
    discountValue: number;     // 割引額
    validityPeriod: number;    // 有効期間（日数）- 発行日からの期間
    isActive: boolean;         // 有効/無効フラグ
}

// ユーザークーポン（ユーザーに発行されたクーポン）
export interface UserCoupon {
    id: string;
    userId: string;
    name: string;              // 表示用
    code: string;              // 表示用
    description: string;       // 表示用
    discountValue: number;
    status: 'available' | 'used';  // 利用可能or使用済み
    issuedAt: TimestampOrString;   // 発行日
    appliedMonthPeriod?: string;   // 適用された月（"2025-04"形式）
}