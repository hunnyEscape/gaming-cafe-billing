import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { COLLECTIONS, SEAT_STATUS } from '../../config/constants';
import { Session, Seat } from '../../types';

/**
 * セッション開始HTTP関数
 * ユーザーIDと座席IDで認証を行い、新しいセッションを開始します
 */
export const startSessionHttp = functions.https.onRequest(async (req, res) => {
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

		const userId = data.userId;
		const seatId = data.seatId;

		// ユーザーIDとseatIdのチェック
		if (!userId || !seatId) {
			res.status(400).json({
				success: false,
				error: 'ユーザーID(userId)と座席ID(seatId)は必須です'
			});
			return;
		}

		// Firestoreデータベース参照
		const db = admin.firestore();

		// ユーザーIDの存在を確認
		const userRef = db.collection(COLLECTIONS.USERS).doc(userId);
		const userDoc = await userRef.get();

		if (!userDoc.exists) {
			res.status(404).json({
				success: false,
				error: '指定されたユーザーIDが見つかりません'
			});
			return;
		}

		// 次に、指定された座席IDの情報を取得
		const seatRef = db.collection(COLLECTIONS.SEATS).doc(seatId);
		const seatDoc = await seatRef.get();

		if (!seatDoc.exists) {
			res.status(404).json({
				success: false,
				error: '指定された座席IDが見つかりません'
			});
			return;
		}

		const seatData = seatDoc.data() as Seat;

		// 座席が利用可能か確認
		if (seatData.status !== SEAT_STATUS.AVAILABLE) {
			res.status(409).json({
				success: false,
				error: `この座席は現在利用できません。状態: ${seatData.status}`
			});
			return;
		}

		// 既にアクティブなセッションがないか確認
		const sessionsRef = db.collection(COLLECTIONS.SESSIONS);
		const activeSessionQuery = await sessionsRef
			.where('seatId', '==', seatId)
			.where('active', '==', true)
			.limit(1)
			.get();

		if (!activeSessionQuery.empty) {
			res.status(409).json({
				success: false,
				error: 'この座席では既にアクティブなセッションが存在します'
			});
			return;
		}

		// トランザクションを使用してセッション作成と座席状態更新を実行
		const result = await db.runTransaction(async (transaction) => {
			// 一意のセッションIDを生成
			const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

			// 新しいセッションデータを作成
			const sessionData: Session = {
				sessionId,
				userId,
				seatId,
				startTime: admin.firestore.Timestamp.now(),
				endTime: null,
				durationMinutes: 0,
				pricePerMinute: seatData.ratePerMinute || 10, // デフォルト料金: 10円/分
				amount: 0,
				active: true,
				billingId: null
			};

			// Firestoreにセッションを追加
			const sessionRef = db.collection(COLLECTIONS.SESSIONS).doc(sessionId);
			transaction.set(sessionRef, sessionData);

			// 座席のステータスを更新
			transaction.update(seatRef, {
				status: SEAT_STATUS.IN_USE,
				updatedAt: admin.firestore.Timestamp.now()
			});

			// 成功レスポンス用にセッション情報を返す
			return {
				sessionId,
				userId,
				seatId,
				startTime: sessionData.startTime
			};
		});

		functions.logger.info(`セッション開始成功: ${result.sessionId}, ユーザー: ${userId}, 座席: ${seatId}`);

		// 成功レスポンスを返す
		res.status(200).json({
			success: true,
			message: 'セッションが正常に開始されました',
			session: result
		});
	} catch (error: unknown) {
		// エラーログ
		functions.logger.error('セッション開始エラー:', error);

		// エラーレスポンスを返す
		res.status(500).json({
			success: false,
			error: error instanceof Error ? error.message : 'セッション開始中に内部エラーが発生しました'
		});
	}
});