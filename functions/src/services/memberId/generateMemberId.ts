import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';

/**
 * 新規ユーザー登録時に会員IDデータを初期化するFirestoreトリガー
 */
export const initMemberIdOnCreate = functions.region('asia-northeast1').firestore
	.document('users/{userId}')
	.onCreate(async (snapshot, context) => {
		try {
			const userId = context.params.userId;
			const userData = snapshot.data();

			// 既に会員IDがある場合は処理をスキップ
			if (userData && userData.currentMemberId && userData.previousMemberId) {
				functions.logger.info(`User ${userId} already has member IDs`);
				return { success: false, reason: 'User already has member IDs' };
			}

			// 現在の時間を6分間隔で切り捨て
			const now = new Date();
			const timeFrameMinutes = 6;
			const minutes = Math.floor(now.getMinutes() / timeFrameMinutes) * timeFrameMinutes;
			const timeFrame = new Date(
				now.getFullYear(),
				now.getMonth(),
				now.getDate(),
				now.getHours(),
				minutes,
				0,
				0
			);

			const timeStamp = timeFrame.getTime().toString();

			// タイムスタンプとuidを組み合わせて会員IDを生成
			const idBase = `${timeStamp}-${userId}`;
			const hash = crypto.createHash('sha256').update(idBase).digest('hex');

			// ハッシュを短縮して読みやすいフォーマットに
			const shortHash = hash.substring(0, 12);
			const memberId = `ES-${shortHash.substring(0, 5)}-${shortHash.substring(5, 10)}`.toUpperCase();

			// ユーザードキュメントを更新（初期状態では同じIDを両方に設定）
			await snapshot.ref.update({
				currentMemberId: memberId,
				previousMemberId: memberId, // 初期状態では同じIDを両方に設定
				memberIdUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
			});

			functions.logger.info(`Generated member ID for user: ${userId}`);
			return {
				success: true,
				currentMemberId: memberId
			};
		} catch (e) {
			functions.logger.error('initMemberIdOnCreate error:', e);
			return { success: false, error: (e as Error).message };
		}
	});