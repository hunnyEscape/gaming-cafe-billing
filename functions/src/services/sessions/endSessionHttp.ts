import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { COLLECTIONS, SEAT_STATUS } from '../../config/constants';
import { Session } from '../../types';

/**
 * セッション終了HTTP関数
 * セッションIDまたは座席IDを受け取り、セッションを終了して利用料金を計算します
 */
export const endSessionHttp = functions.https.onRequest(async (req, res) => {
	// CORSヘッダー設定
	res.set('Access-Control-Allow-Origin', '*');
	res.set('Access-Control-Allow-Methods', 'GET, POST');
	res.set('Access-Control-Allow-Headers', 'Content-Type');

	// OPTIONSリクエスト（プリフライト）への対応
	if (req.method === 'OPTIONS') {
		res.status(204).send('');
		return;
	}

	// POSTメソッド以外は受け付けない
	if (req.method !== 'POST') {
		res.status(405).json({
			success: false,
			error: 'Method not allowed. Please use POST.'
		});
		return;
	}

	try {
		// リクエストデータのログ出力（デバッグ用）
		functions.logger.info('Request body:', req.body);

		const data = req.body;

		// データがnullまたは未定義の場合のチェック
		if (!data) {
			res.status(400).json({
				success: false,
				error: 'リクエストデータが見つかりません'
			});
			return;
		}

		const sessionId = data.sessionId;
		const seatId = data.seatId;

		// セッションIDまたは座席IDのどちらかは必須
		if (!sessionId && !seatId) {
			res.status(400).json({
				success: false,
				error: 'セッションID(sessionId)または座席ID(seatId)のいずれかが必要です'
			});
			return;
		}

		// Firestoreデータベース参照
		const db = admin.firestore();

		// セッションの検索
		let sessionRef: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>;
		let sessionDoc: FirebaseFirestore.DocumentSnapshot<FirebaseFirestore.DocumentData>;

		if (sessionId) {
			// セッションIDが指定された場合は直接取得
			sessionRef = db.collection(COLLECTIONS.SESSIONS).doc(sessionId);
			sessionDoc = await sessionRef.get();

			if (!sessionDoc.exists) {
				res.status(404).json({
					success: false,
					error: '指定されたセッションIDが見つかりません'
				});
				return;
			}
		} else {
			// 座席IDからアクティブなセッションを検索
			const sessionsRef = db.collection(COLLECTIONS.SESSIONS);
			const activeSessionQuery = await sessionsRef
				.where('seatId', '==', seatId)
				.where('active', '==', true)
				.limit(1)
				.get();

			if (activeSessionQuery.empty) {
				res.status(404).json({
					success: false,
					error: 'この座席でアクティブなセッションが見つかりません'
				});
				return;
			}

			sessionDoc = activeSessionQuery.docs[0];
			sessionRef = sessionDoc.ref;
		}

		const sessionData = sessionDoc.data() as Session;

		// 既に終了しているセッションの場合はエラー
		if (!sessionData.active) {
			res.status(409).json({
				success: false,
				error: 'このセッションはすでに終了しています'
			});
			return;
		}

		// トランザクションによるセッション終了処理
		const result = await db.runTransaction(async (transaction) => {
			// 現在時刻を終了時間として設定
			const endTime = admin.firestore.Timestamp.now();

			// 利用時間の計算（分単位、切り上げ）
			const startTimeMs = sessionData.startTime.toMillis();
			const endTimeMs = endTime.toMillis();
			const durationMinutes = Math.ceil((endTimeMs - startTimeMs) / (1000 * 60));

			// 料金の計算
			const amount = durationMinutes * sessionData.pricePerMinute;

			// セッション情報の更新
			transaction.update(sessionRef, {
				endTime: endTime,
				durationMinutes: durationMinutes,
				amount: amount,
				active: false
			});

			// 座席のステータスを「available」に戻す
			const seatRef = db.collection(COLLECTIONS.SEATS).doc(sessionData.seatId);
			transaction.update(seatRef, {
				status: SEAT_STATUS.AVAILABLE,
				updatedAt: admin.firestore.Timestamp.now()
			});

			// 課金キューの作成（後続の課金処理用、オプション）
			const billingQueueRef = db.collection(COLLECTIONS.BILLING_QUEUE).doc();
			transaction.set(billingQueueRef, {
				sessionId: sessionData.sessionId,
				userId: sessionData.userId,
				seatId: sessionData.seatId,
				status: 'pending',
				createdAt: admin.firestore.Timestamp.now()
			});

			// 結果を返す
			return {
				sessionId: sessionData.sessionId,
				userId: sessionData.userId,
				seatId: sessionData.seatId,
				startTime: sessionData.startTime,
				endTime: endTime,
				durationMinutes: durationMinutes,
				amount: amount
			};
		});

		functions.logger.info(`セッション終了成功: ${result.sessionId}, 利用時間: ${result.durationMinutes}分, 料金: ${result.amount}円`);

		// 成功レスポンスを返す
		res.status(200).json({
			success: true,
			message: 'セッションが正常に終了しました',
			session: result
		});
	} catch (error: unknown) {
		// エラーログ
		functions.logger.error('セッション終了エラー:', error);

		// エラーレスポンスを返す
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'セッション終了中に内部エラーが発生しました'
		});
	}
});