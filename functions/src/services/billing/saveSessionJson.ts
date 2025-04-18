import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { COLLECTIONS } from '../../config/constants';
import { SessionDocument, UserDocument } from '../../types';

export const saveSessionJson = functions.firestore
	.document(`${COLLECTIONS.BILLING_QUEUE}/{docId}`)
	.onCreate(async (snapshot, context) => {
		try {
			const { sessionId, userId, seatId } = snapshot.data() as {
				sessionId: string;
				userId: string;
				seatId: string;
			};

			functions.logger.info(
				`セッションデータJSON生成開始: SessionID=${sessionId}, UserID=${userId}, SeatID=${seatId}`
			);

			const db = admin.firestore();

			// セッション詳細を取得
			const sessionDoc = await db.collection(COLLECTIONS.SESSIONS).doc(sessionId).get();
			if (!sessionDoc.exists) throw new Error('セッションが見つかりません');
			const sessionData = sessionDoc.data() as SessionDocument;

			// 終了チェック
			if (sessionData.active || !sessionData.endTime) {
				throw new Error('セッションがまだ終了していません');
			}

			// ユーザー情報取得（オプション）
			const userDoc = await db.collection(COLLECTIONS.USERS).doc(userId).get();
			const userData = userDoc.exists ? (userDoc.data() as UserDocument) : null;
			const membershipType =
				userData?.stripe?.paymentStatus === 'active' ? 'premium' : 'standard';

			// JSON 構造の生成
			const billingJson = {
				sessionId,
				userId,
				seatId,
				startTime:
					sessionData.startTime instanceof admin.firestore.Timestamp
						? sessionData.startTime.toDate().toISOString()
						: sessionData.startTime,
				endTime:
					sessionData.endTime instanceof admin.firestore.Timestamp
						? sessionData.endTime.toDate().toISOString()
						: sessionData.endTime,
				duration: sessionData.duration,          // ← 新フィールド
				hourBlocks: sessionData.hourBlocks ?? 0, // ← 新フィールド
				memberType: membershipType,
				timestamp: Date.now()
			};

			const jsonString = JSON.stringify(billingJson, null, 2);

			// ファイル名・パスを JST で生成
			const now = new Date();
			const jstString = now
				.toLocaleString('ja-JP', {
					timeZone: 'Asia/Tokyo',
					year: 'numeric',
					month: '2-digit',
					day: '2-digit',
					hour: '2-digit',
					minute: '2-digit',
					second: '2-digit',
					hour12: false
				})
				.replace(/[\/\s:]/g, '');

			const fileName = `${jstString}_${sessionId}.json`;
			const storagePath = `sessionLog/${userId}/${fileName}`;

			// Cloud Storage に保存
			const bucket = admin.storage().bucket();
			await bucket.file(storagePath).save(jsonString, {
				contentType: 'application/json',
				metadata: { userId, sessionId }
			});

			// SHA256 ハッシュ
			const hashValue = crypto.createHash('sha256').update(jsonString).digest('hex');

			// Proofs コレクションに保存
			const proofData = {
				sessionId,
				userId,
				seatId,
				fileUrl: storagePath,
				hash: hashValue,
				status: 'pending',
				createdAt: admin.firestore.Timestamp.now()
			};
			await db.collection(COLLECTIONS.BILLING_PROOFS).doc(sessionId).set(proofData);

			// キューの状態更新
			await snapshot.ref.update({
				status: 'processed',
				hashValue,
				updatedAt: admin.firestore.Timestamp.now()
			});

			functions.logger.info(`JSON生成完了: SessionID=${sessionId}, Hash=${hashValue}`);
			return { success: true, hashValue };
		} catch (error) {
			functions.logger.error('JSON生成エラー:', error instanceof Error ? error.message : String(error));
			await snapshot.ref.update({
				status: 'error',
				errorMessage: error instanceof Error ? error.message : String(error),
				updatedAt: admin.firestore.Timestamp.now()
			});
			throw error;
		}
	});
