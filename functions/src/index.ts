import * as admin from 'firebase-admin';

// Firebase初期化
admin.initializeApp();

// セッション関連の関数をエクスポート
//export { startSession } from './services/sessions/startSession';
export { startSessionHttp } from './services/sessions/startSessionHttp';
export { endSessionHttp } from './services/sessions/endSessionHttp';
export { generateBillingJSON } from './services/billing/generateBillingJSON';
export { saveHashToBlockchain } from './services/billing/saveHashToBlockchain';
export { saveSessionJson } from './services/billing/saveSessionJson';