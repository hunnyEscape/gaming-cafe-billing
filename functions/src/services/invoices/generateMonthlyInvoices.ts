import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import { COLLECTIONS } from '../../config/constants';
import { processUserSessions } from './processUserSessions';

/**
 * 月次請求書生成Cloud Function
 * 毎月1日の00:00に自動実行 (日本時間)
 */
export const generateMonthlyInvoices = functions.region('asia-northeast1')
	.pubsub.schedule('0 0 1 * *')  // 毎月1日の00:00 (UTC)
	.timeZone('Asia/Tokyo')  // 日本時間で設定
	.onRun(async (_context) => {
		try {
			const result = await generateMonthlyInvoicesLogic();
			functions.logger.info('Monthly invoice generation completed', result);
			return null;  // Firebaseの関数では成功時にnullを返す
		} catch (error) {
			functions.logger.error('Error in generateMonthlyInvoices:', error);
			return null;  // エラー発生時も成功として扱い、再実行を防止
		}
	});

/**
 * HTTPトリガーバージョン (手動実行用)
 */
export const generateMonthlyInvoicesHttp = functions.https.onRequest(async (req, res) => {
	try {
		// POSTリクエストのみ受け付ける
		if (req.method !== 'POST') {
			res.status(405).send('Method Not Allowed');
			return;
		}

		// 認証チェック部分を削除

		const result = await generateMonthlyInvoicesLogic();
		res.status(200).json(result);
	} catch (error) {
		functions.logger.error('Error in generateMonthlyInvoicesHttp:', error);
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'Unknown error'
		});
	}
});

/**
 * 月次請求書生成の共通ロジック
 */
async function generateMonthlyInvoicesLogic() {
	const db = admin.firestore();

	try {
		// 前月の期間を計算（日本時間基準）
		const now = new Date();
		const currentYear = now.getFullYear();
		const currentMonth = now.getMonth(); // 0-11

		// 日本時間の前月1日 00:00:00 → UTC時間では前日の15:00:00
		const startDate = new Date(currentYear, currentMonth - 1, 1, -9, 0, 0, 0);

		// 日本時間の前月末日 23:59:59.999 → UTC時間では前日の14:59:59.999
		const endDate = new Date(currentYear, currentMonth, 0, 14, 59, 59, 999);

		functions.logger.info(`Generating invoices for period: ${startDate.toISOString()} to ${endDate.toISOString()}`);

		// Firestoreのタイムスタンプに変換
		const periodStart = admin.firestore.Timestamp.fromDate(startDate);
		const periodEnd = admin.firestore.Timestamp.fromDate(endDate);

		// 前月の期間文字列 (YYYY-MM形式)
		const periodString = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}`;

		// 期間文字列を使って、既に処理済みかチェック
		const existingInvoicesQuery = await db.collection(COLLECTIONS.INVOICES)
			.where('periodString', '==', periodString)
			.limit(1)
			.get();

		if (!existingInvoicesQuery.empty) {
			functions.logger.info(`Invoices for period ${periodString} already generated. Skipping.`);
			return { success: true, message: `Invoices for period ${periodString} already generated.` };
		}

		// アクティブユーザーを取得
		const usersQuery = await db.collection(COLLECTIONS.USERS)
			.where('registrationCompleted', '==', true)
			.get();

		if (usersQuery.empty) {
			functions.logger.info('No active users found');
			return { success: true, message: 'No active users found' };
		}

		const userCount = usersQuery.size;
		functions.logger.info(`Processing invoices for ${userCount} users`);

		// 請求書カウンター
		let successCount = 0;
		let errorCount = 0;

		// 各ユーザーの請求書を処理
		const processPromises = usersQuery.docs.map(async (userDoc) => {
			const userData = userDoc.data();
			const userId = userDoc.id;

			try {
				functions.logger.debug(`Processing user: ${userId}`);

				const result = await processUserSessions(
					userId,
					userData.email || '',
					periodStart,
					periodEnd,
					periodString
				);

				if (result.success) {
					successCount++;
					functions.logger.debug(`Successfully processed invoice for user: ${userId}`);
				} else {
					errorCount++;
					functions.logger.error(`Failed to process invoice for user: ${userId}`, result.error);
				}

				return result;
			} catch (error) {
				errorCount++;
				functions.logger.error(`Error processing user ${userId}:`, error);
				return {
					success: false,
					userId,
					error: error instanceof Error ? error.message : 'Unknown error'
				};
			}
		});

		// すべてのユーザー処理を待機
		await Promise.all(processPromises);

		functions.logger.info(`Invoice generation completed. Success: ${successCount}, Error: ${errorCount}`);
		return {
			success: true,
			processed: successCount,
			errors: errorCount,
			period: periodString
		};
	} catch (error) {
		functions.logger.error('Error in generateMonthlyInvoicesLogic:', error);
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Unknown error'
		};
	}
}