/*jslint node: true */
"use strict";

//exports.port = 6611;
//exports.myUrl = 'wss://mydomain.com/bb';
exports.bServeAsHub = false;
exports.bLight = false;


exports.storage = 'sqlite';


exports.hub = 'byteball.org/bb';
exports.deviceName = 'Headless';
exports.admin_email='hoge@mail.com';
exports.from_email='hoge@ mail.com';
exports.bSingleAddress = true;
//ランダムな文字列。ペアリングコードの一部になる
exports.permanent_pairing_secret = '0000';
//チャットを許可するデバイスのアドレスを設定
exports.control_addresses = [''];
exports.payout_address = 'WHERE THE MONEY CAN BE SENT TO';
exports.KEYS_FILENAME = 'keys.json';

// where logs are written to (absolute path).  Default is log.txt in app data directory
//exports.LOG_FILENAME = '/dev/null';

// consolidate unspent outputs when there are too many of them.  Value of 0 means do not try to consolidate
exports.MAX_UNSPENT_OUTPUTS = 0;
exports.CONSOLIDATION_INTERVAL = 3600*1000;

// this is for runnining RPC service only, see play/rpc_service.js
exports.rpcInterface = '127.0.0.1';
exports.rpcPort = '6332';

console.log('finished headless conf');
