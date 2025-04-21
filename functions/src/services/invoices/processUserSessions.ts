import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { COLLECTIONS, INVOICE_STATUS } from '../../config/constants';
import { InvoiceDocument, InvoiceSessionItem } from '../../types/invoice';
import { SessionDocument, SeatDocument } from '../../types';
import { applyCoupons } from './applyCoupons';

/**
 * 特定ユーザーの月間セッションを処理し、請求書を生成する
 * 
 * @param userId ユーザーID
 * @param userEmail ユーザーメールアドレス
 * @param periodStart 期間開始日
 * @param periodEnd 期間終了日
 * @param periodString 期間文字列（YYYY-MM形式）
 * @returns 処理結果
 */
export const processUserSessions = async (
	userId: string,
	userEmail: string,
	periodStart: admin.firestore.Timestamp,
	periodEnd: admin.firestore.Timestamp,
	periodString: string
): Promise<{ success: boolean; invoiceId?: string; error?: string; userId: string }> => {
	const db = admin.firestore();

	try {
		// 指定期間内のセッションを取得（アクティブではないもののみ）
		const sessionsQuery = await db.collection(COLLECTIONS.SESSIONS)
			.where('userId', '==', userId)
			.where('active', '==', false)
			.where('endTime', '>=', periodStart)
			.where('endTime', '<=', periodEnd)
			.get();

		if (sessionsQuery.empty) {
			functions.logger.info(`No sessions found for user ${userId} in period ${periodString}`);
			return { success: true, userId, invoiceId: undefined };
		}

		// 座席情報をあらかじめ取得
		const seatsSnapshot = await db.collection(COLLECTIONS.SEATS).get();
		const seatsMap = new Map<string, SeatDocument>();

		seatsSnapshot.forEach((doc) => {
			const seatData = doc.data() as SeatDocument;
			seatsMap.set(seatData.seatId, seatData);
		});

		// セッション情報を処理
		const invoiceSessionItems: InvoiceSessionItem[] = [];
		let subtotalAmount = 0;

		for (const sessionDoc of sessionsQuery.docs) {
			const sessionData = sessionDoc.data() as SessionDocument;
			const seatInfo = seatsMap.get(sessionData.seatId);

			// セッションの金額計算
			const hourBlocks = sessionData.hourBlocks || 0;
			const amount = hourBlocks * (sessionData.pricePerHour || 600);

			invoiceSessionItems.push({
				sessionId: sessionData.sessionId,
				startTime: sessionData.startTime,
				endTime: sessionData.endTime,
				hourBlocks: hourBlocks,
				amount: amount,
				seatId: sessionData.seatId,
				seatName: seatInfo?.name || `座席 ${sessionData.seatId}`,
				branchName: seatInfo?.branchName || '',
				blockchainTxId: sessionData.blockchainTxId || undefined
			});

			subtotalAmount += amount;
		}

		// クーポンを適用
		const { appliedCoupons, totalDiscountAmount } = await applyCoupons(userId, subtotalAmount, periodString);

		// 最終金額を計算
		const finalAmount = Math.max(0, subtotalAmount - totalDiscountAmount);

		// 請求書IDを生成
		const invoiceId = `inv_${periodString}_${userId.substring(0, 8)}_${Date.now().toString(36)}`;

		// 請求書データを作成
		const invoiceData: InvoiceDocument = {
			invoiceId,
			userId,
			userEmail,
			periodStart,
			periodEnd,
			periodString,
			subtotalAmount,
			discountAmount: totalDiscountAmount,
			finalAmount,
			sessions: invoiceSessionItems,
			appliedCoupons,
			status: INVOICE_STATUS.PENDING_STRIPE as "pending_stripe",
			createdAt: admin.firestore.Timestamp.now()
		};

		// Firestoreに保存
		await db.collection(COLLECTIONS.INVOICES).doc(invoiceId).set(invoiceData);

		functions.logger.info(`Created invoice ${invoiceId} for user ${userId} with ${invoiceSessionItems.length} sessions, total: ${finalAmount} JPY`);

		return { success: true, invoiceId, userId };
	} catch (error) {
		functions.logger.error(`Error processing sessions for user ${userId}:`, error);
		return { success: false, error: error instanceof Error ? error.message : 'Unknown error', userId };
	}
};