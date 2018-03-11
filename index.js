/*jslint node: true */
"use strict";

var conf = require('byteballcore/conf.js');
var db = require('byteballcore/db.js');
var eventBus = require('byteballcore/event_bus.js');
var headlessWallet = require('headless-byteball');
var desktopApp = require('byteballcore/desktop_app.js');
var objectHash = require('byteballcore/object_hash.js');
var notifications = require('./notifications.js');
var ValidationUtils = require("byteballcore/validation_utils.js");
var my_address;
var wallet_id;

//******* */
//独自変数
//******* */
var feedname;
var feedvalue;
var paired_device_address;
var state = '';
var welcometext = "";
	welcometext += "コマンド\n";
	welcometext += "[スマートコントラクト作成](command:contract)\n";

//
if (conf.bRunWitness)
	require('byteball-witness');

const RETRY_TIMEOUT = 5 * 60 * 1000;
var assocQueuedDataFeeds = {};

const WITNESSING_COST = 600; // size of typical witnessing unit
var count_witnessings_available = 0;

if (!conf.bSingleAddress)
	throw Error('oracle must be single address');

if (!conf.bRunWitness)
	headlessWallet.setupChatEventHandlers();

// this duplicates witness code if we are also running a witness
function readNumberOfWitnessingsAvailable(handleNumber) {
	count_witnessings_available--;
	if (count_witnessings_available > conf.MIN_AVAILABLE_WITNESSINGS)
		return handleNumber(count_witnessings_available);
	db.query(
		"SELECT COUNT(*) AS count_big_outputs FROM outputs JOIN units USING(unit) \n\
		WHERE address=? AND is_stable=1 AND amount>=? AND asset IS NULL AND is_spent=0", [my_address, WITNESSING_COST],
		function(rows) {
			var count_big_outputs = rows[0].count_big_outputs;
			db.query(
				"SELECT SUM(amount) AS total FROM outputs JOIN units USING(unit) \n\
				WHERE address=? AND is_stable=1 AND amount<? AND asset IS NULL AND is_spent=0 \n\
				UNION \n\
				SELECT SUM(amount) AS total FROM witnessing_outputs \n\
				WHERE address=? AND is_spent=0 \n\
				UNION \n\
				SELECT SUM(amount) AS total FROM headers_commission_outputs \n\
				WHERE address=? AND is_spent=0", [my_address, WITNESSING_COST, my_address, my_address],
				function(rows) {
					var total = rows.reduce(function(prev, row) {
						return (prev + row.total);
					}, 0);
					var count_witnessings_paid_by_small_outputs_and_commissions = Math.round(total / WITNESSING_COST);
					count_witnessings_available = count_big_outputs + count_witnessings_paid_by_small_outputs_and_commissions;
					handleNumber(count_witnessings_available);
				}
			);
		}
	);
}


//****************** */
//DAGへの書き込み部分
//******************
// make sure we never run out of spendable (stable) outputs. Keep the number above a threshold, and if it drops below, produce more outputs than consume.
function createOptimalOutputs(handleOutputs) {
	var arrOutputs = [{
		amount: 0,
		address: my_address
	}];
	readNumberOfWitnessingsAvailable(function(count) {
		if (count > conf.MIN_AVAILABLE_WITNESSINGS)
			return handleOutputs(arrOutputs);
		// try to split the biggest output in two
		db.query(
			"SELECT amount FROM outputs JOIN units USING(unit) \n\
			WHERE address=? AND is_stable=1 AND amount>=? AND asset IS NULL AND is_spent=0 \n\
			ORDER BY amount DESC LIMIT 1", [my_address, 2 * WITNESSING_COST],
			function(rows) {
				if (rows.length === 0) {
					notifications.notifyAdminAboutPostingProblem('only ' + count + " spendable outputs left, and can't add more");
					return handleOutputs(arrOutputs);
				}
				var amount = rows[0].amount;
				//	notifications.notifyAdminAboutPostingProblem('only '+count+" spendable outputs left, will split an output of "+amount);
				arrOutputs.push({
					amount: Math.round(amount / 2),
					address: my_address
				});
				console.log(arrOutputs);
				handleOutputs(arrOutputs);
			}
		);
	});
}



function postDataFeed(datafeed, onDone) {
	function onError(err) {
		notifications.notifyAdminAboutFailedPosting(err);
		onDone(err);
	}
	var network = require('byteballcore/network.js');
	var composer = require('byteballcore/composer.js');
	createOptimalOutputs(function(arrOutputs) {
		let params = {
			paying_addresses: [my_address],
			outputs: arrOutputs,
			signer: headlessWallet.signer,
			callbacks: composer.getSavingCallbacks({
				ifNotEnoughFunds: onError,
				ifError: onError,
				ifOk: function(objJoint) {
					network.broadcastJoint(objJoint);
					onDone();
				}
			})
		};
		if (conf.bPostTimestamp)
			datafeed.timestamp = Date.now();

		let objMessage = {
			app: "data_feed",
			payload_location: "inline",
			payload_hash: objectHash.getBase64Hash(datafeed),
			payload: datafeed
		};
		params.messages = [objMessage];
		composer.composeJoint(params);
	});
}

function reliablyPostDataFeed(datafeed) {
	var feed_name, feed_value;
	for (var key in datafeed) {
		feed_name = key;
		feed_value = datafeed[key];
		break;
	}
	if (!feed_name)
		throw Error('no feed name');
	if (assocQueuedDataFeeds[feed_name]) // already queued
		return console.log(feed_name + " already queued");
	assocQueuedDataFeeds[feed_name] = feed_value;
	var onDataFeedResult = function(err) {
		if (err) {
			console.log('will retry posting the data feed later');
			setTimeout(function() {
				postDataFeed(datafeed, onDataFeedResult);
			}, RETRY_TIMEOUT + Math.round(Math.random() * 3000));
		}
		else
			delete assocQueuedDataFeeds[feed_name];
	};
	postDataFeed(datafeed, onDataFeedResult);
}


//*********************************
//データ読み書き実装部
//*********************************
	function handleText(from_address, text, onUnknown){
		text = text.trim();
		var fields = text.split(/ /);
		var command = fields[0].trim().toLowerCase();
		var params =['',''];
		if (fields.length > 1) params[0] = fields[1].trim();
		if (fields.length > 2) params[1] = fields[2].trim();

		var walletDefinedByKeys = require('byteballcore/wallet_defined_by_keys.js');
		var device = require('byteballcore/device.js');


		//状態に応じた処理＊コマンドで分けきれない細かい状態の管理＊
		switch(state){
			case 'contract':
				state = '';
				text = text.trim();
				if (text.match(/unrecognized/i))
					return console.log("ignoring: "+text);
				var arrMatches = text.match(/\b[A-Z2-7]{32}\b/);
				if (!arrMatches)
					device.sendMessageToDevice(from_address, 'text', "Unrecognized");
					
				var date1 = new Date();
                		date1.setMinutes(date1.getMinutes() + 60);
                		var date2 = new Date();
                		date2.setMinutes(date2.getMinutes() + 10);

				var address = arrMatches[0];
				if (!ValidationUtils.isValidAddress(address)){
					device.sendMessageToDevice(from_address, 'text', "Please send a valid address.有効なアドレスを入力してください");
				}
				else{
					var arrDefinition = ['or', [
							['and', [
											['address',address],//useraddress
											['in data feed', [['I2ADHGP4HL6J37NQAD73J7E5SKFIXJOT'], 'timestamp', '>',  date1.getTime()]]
											//I2ADHGP4HL6J37NQAD73J7E5SKFIXJOTはタイムスタンプオラクルのアドレスです。
									]
							],
							['and', [
											['address', my_address],//myaddress
											['in data feed', [['I2ADHGP4HL6J37NQAD73J7E5SKFIXJOT'], 'timestamp', '>',  date2.getTime()]]
									]
							]
					]];
				}
				var device = require('byteballcore/device.js');
				var assocSignersByPath = {
				'r.0.0': {
						address:address,//user_address
						member_signing_path: 'r', // unused, should be always 'r'
						device_address: from_address //user device address
				},
				'r.1.0': {
						address: my_address,//my_address
						member_signing_path: 'r', // unused, should be always 'r'
						device_address: device.getMyDeviceAddress()
				}
				};
				var walletDefinedByAddresses = require('byteballcore/wallet_defined_by_addresses.js');
				walletDefinedByAddresses.createNewSharedAddress(arrDefinition, assocSignersByPath, {
				ifError: function(err){
						// handle error
						device.sendMessageToDevice(from_address, 'text', 'contract create error:'+err);
				},
				ifOk: function(shared_address){
					device.sendMessageToDevice(from_address, 'text', "A Smart Contract was created. \ nYou can check the contents by clicking the link below.\nスマートコントラクトが作成されました。\n下記のリンクをクリックで内容を確認できます。");
					// new sharer address created
					//1000は相手に要求する支払額。任意の値に変更可能
						var arrPayments = [{address: shared_address, amount: 1000, asset: 'base'}];
								var assocDefinitions = {};
								assocDefinitions[shared_address] = {
										definition: arrDefinition,
										signers: assocSignersByPath
								};
						var objPaymentRequest = {payments: arrPayments, definitions: assocDefinitions};
						var paymentJson = JSON.stringify(objPaymentRequest);
						var paymentJsonBase64 = Buffer(paymentJson).toString('base64');
						var paymentRequestCode = 'payment:'+paymentJsonBase64;
						var paymentRequestText = '[your share of payment to the contract]('+paymentRequestCode+')';
						device.sendMessageToDevice(from_address, 'text', paymentRequestText);
						}
				});
				return;
		}

		//コマンド処理
		switch(command){
			case 'help':
				device.sendMessageToDevice(from_address, 'text',welcometext);
				break;
			case 'address':
				state = 'menu';
				device.sendMessageToDevice(from_address, 'text',my_address);
				break;
			case 'contract':
				state = 'contract';
				device.sendMessageToDevice(from_address, 'text', "Please enter your wallet address.\nあなたのウォレットアドレスを入力してください(Insert my addressで簡単に入力できます)");
				break;
			default:
				if (onUnknown){
					onUnknown(from_address, text);
				}else{
					device.sendMessageToDevice(from_address, 'text', "unrecognized command");
				}
		}
	}
	
//******************************
//待ち受けイベント設定
//******************************
eventBus.on('text', function(from_address, text){
		console.log('text from '+from_address+': '+text);

		handleText(from_address, text);
	});
	
	eventBus.on('headless_wallet_ready', function() {
		headlessWallet.readSingleAddress(function(address) {
			my_address = address;
			//device.getMyDeviceAddress()
		});
	});

	eventBus.on('paired', function(from_address){
		var device = require('byteballcore/device.js');
		console.log('paired '+from_address);
		device.sendMessageToDevice(from_address, 'text',welcometext);
	});
