import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';

/**
 * 6分おきに実行されるスケジュール関数
 * 全ユーザーの会員IDを更新する
 */
export const updateMemberIds = functions.region('asia-northeast1')
	.pubsub.schedule('every 6 minutes')
	.onRun(async (context) => {
		try {
			const db = admin.firestore();
			const batchSize = 500; // 一度に処理する最大ユーザー数

			// 会員IDが設定されているユーザーを取得
			const usersSnapshot = await db
				.collection('users')
				.where('currentMemberId', '!=', null)
				.limit(batchSize)
				.get();

			if (usersSnapshot.empty) {
				functions.logger.info('No users with memberId found.');
				return null;
			}

			const batch = db.batch();
			let count = 0;

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

			// タイムスタンプを文字列化
			const timeStamp = timeFrame.getTime().toString();

			// 各ユーザーの会員IDを生成
			for (const userDoc of usersSnapshot.docs) {
				const userData = userDoc.data();
				const userId = userDoc.id;

				// 現在の会員IDを前の会員IDに移動
				const previousMemberId = userData.currentMemberId;

				// 新しいタイムスタンプとuidで新しい会員IDを生成
				const idBase = `${timeStamp}-${userId}`;
				const hash = crypto.createHash('sha256').update(idBase).digest('hex');
				const shortHash = hash.substring(0, 12);
				const currentMemberId = `ES-${shortHash.substring(0, 5)}-${shortHash.substring(5, 10)}`.toUpperCase();

				// 新しい会員IDを設定
				batch.update(userDoc.ref, {
					currentMemberId: currentMemberId,
					previousMemberId: previousMemberId,
					memberIdUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
				});

				count++;
			}

			if (count > 0) {
				await batch.commit();
				functions.logger.info(`Updated member IDs for ${count} users.`);
			}

			return null;
		} catch (error) {
			functions.logger.error('Error updating member IDs:', error);
			throw error;
		}
	});
