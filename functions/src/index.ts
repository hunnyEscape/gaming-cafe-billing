import * as admin from 'firebase-admin';

// Firebase初期化
admin.initializeApp();

// セッション関連の関数をエクスポート
export { startSessionHttp } from './services/sessions/startSessionHttp';
export { endSessionHttp } from './services/sessions/endSessionHttp';
export { saveSessionJsonToBlockchain } from './services/sessions/saveSessionJsonToBlockchain';
export { unlockDoor } from './services/door/unlockDoor';
export { issueNewUserCoupon } from './services/coupons/issueNewUserCoupon';