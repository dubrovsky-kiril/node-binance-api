/* ============================================================
 * node-binance-api
 * https://github.com/jaggedsoft/node-binance-api
 * ============================================================
 * Copyright 2017-, Jon Eyrick
 * Released under the MIT License
 * ============================================================ */

module.exports = function() {
    'use strict';
    const WebSocket = require('ws');
    const request = require('request');
    const crypto = require('crypto');
    const stringHash = require('string-hash');
    const base = 'https://api.binance.com/api/';
    const wapi = 'https://api.binance.com/wapi/';
    const stream = 'wss://stream.binance.com:9443/ws/';
    const combineStream = 'wss://stream.binance.com:9443/stream?streams=';
    const userAgent = 'Mozilla/4.0 (compatible; Node Binance API)';
    const contentType = 'application/x-www-form-urlencoded';
    let subscriptions = {};
    let messageQueue = {};
    let depthCache = {};
    let ohlcLatest = {};
    let klineQueue = {};
    let ohlc = {};
    const default_options = {
        recvWindow: 60000, // to be lowered to 5000 in v0.5
        useServerTime: false,
        reconnect: true,
        verbose: false,
        test: false,
        log: function() {
            console.log(Array.prototype.slice.call(arguments));
        }
    };
    let options = default_options;
    let info = {
        timeOffset: 0
    };

    const publicRequest = function(url, data, callback, method = 'GET') {
        if ( !data ) data = {};
        let opt = {
            url: url,
            qs: data,
            method: method,
            timeout: options.recvWindow,
            agent: false,
            headers: {
                'User-Agent': userAgent,
                'Content-type': contentType
            }
        };
        request(opt, function(error, response, body) {
            if ( !callback ) return;

            if ( error )
                return callback( error, {});

            if ( response && response.statusCode !== 200 )
                return callback( response, {} );

            return callback( null, JSON.parse(body) );
        });
    };

    const apiRequest = function(url, callback, method = 'GET') {
        if ( !options.APIKEY ) throw Error('apiRequest: Invalid API Key');
        let opt = {
            url: url,
            method: method,
            timeout: options.recvWindow,
            agent: false,
            headers: {
                'User-Agent': userAgent,
                'Content-type': contentType,
                'X-MBX-APIKEY': options.APIKEY
            }
        };
        request(opt, function(error, response, body) {
            if ( !callback ) return;

            if ( error )
                return callback( error, {} );

            if ( response && response.statusCode !== 200 )
                return callback( response, {} );

            return callback( null, JSON.parse(body) );
        });
    };

    const marketRequest = function(url, data, callback, method = 'GET') {
        if ( !data ) data = {};
        let query = Object.keys(data).reduce(function(a,k){a.push(k+'='+encodeURIComponent(data[k]));return a},[]).join('&');
        let opt = {
            url: url+'?'+query,
            method: method,
            timeout: options.recvWindow,
            agent: false,
            headers: {
                'User-Agent': userAgent,
                'Content-type': contentType,
                'X-MBX-APIKEY': options.APIKEY
            }
        };
        request(opt, function(error, response, body) {
            if ( !callback ) return;

            if ( error )
                return callback( error, {} );

            if ( response && response.statusCode !== 200 )
                return callback( response, {} );

            return callback( null, JSON.parse(body) );
        });
    };

    const signedRequest = function(url, data, callback, method = 'GET') {
        if ( !options.APISECRET ) throw Error('signedRequest: Invalid API Secret');
        if ( !data ) data = {};
        data.timestamp = new Date().getTime() + info.timeOffset;
        if ( typeof data.symbol !== 'undefined' ) data.symbol = data.symbol.replace('_','');
        if ( typeof data.recvWindow === 'undefined' ) data.recvWindow = options.recvWindow;
        let query = Object.keys(data).reduce(function(a,k){a.push(k+'='+encodeURIComponent(data[k]));return a},[]).join('&');
        let signature = crypto.createHmac('sha256', options.APISECRET).update(query).digest('hex'); // set the HMAC hash header
        let opt = {
            url: url+'?'+query+'&signature='+signature,
            method: method,
            timeout: options.recvWindow,
            agent: false,
            headers: {
                'User-Agent': userAgent,
                'Content-type': contentType,
                'X-MBX-APIKEY': options.APIKEY
            }
        };
        request(opt, function(error, response, body) {
            if ( !callback ) return;

            if ( error )
                return callback( error, {} );

            if ( response && response.statusCode !== 200 )
                return callback( response, {} );

            return callback( null, JSON.parse(body) );
        });
    };

    const order = function(side, symbol, quantity, price, flags = {}, callback = false) {
        let endpoint = 'v3/order';
        if ( options.test ) endpoint += '/test';
        let opt = {
            symbol: symbol,
            side: side,
            type: 'LIMIT',
            quantity: quantity
        };
        if ( typeof flags.type !== 'undefined' ) opt.type = flags.type;
        if ( opt.type.includes('LIMIT') ) {
            opt.price = price;
            opt.timeInForce = 'GTC';
        }
        if ( typeof flags.timeInForce !== 'undefined' ) opt.timeInForce = flags.timeInForce;
        if ( typeof flags.newOrderRespType !== "undefined") opt.newOrderRespType = flags.newOrderRespType;
        if ( typeof flags.newClientOrderId !== "undefined" ) opt.newClientOrderId = flags.newClientOrderId;

        /*
STOP_LOSS
STOP_LOSS_LIMIT
TAKE_PROFIT
TAKE_PROFIT_LIMIT
LIMIT_MAKER
        */
        if ( typeof flags.icebergQty !== 'undefined' ) opt.icebergQty = flags.icebergQty;
        if ( typeof flags.stopPrice !== 'undefined' ) {
            opt.stopPrice = flags.stopPrice;
            if ( opt.type === 'LIMIT' ) throw Error('stopPrice: Must set "type" to one of the following: STOP_LOSS, STOP_LOSS_LIMIT, TAKE_PROFIT, TAKE_PROFIT_LIMIT');
        }
        signedRequest(base+endpoint, opt, function(error, response) {
            if ( !response ) {
                if ( callback ) callback(error, response);
                else options.log('Order() error:', error);
                return;
            }
            if ( typeof response.msg !== 'undefined' && response.msg === 'Filter failure: MIN_NOTIONAL' ) {
                options.log('Order quantity too small. See exchangeInfo() for minimum amounts');
            }
            if ( callback ) callback(error, response);
            else options.log(side+'('+symbol+','+quantity+','+price+') ',response);
        }, 'POST');
    };
    ////////////////////////////
    const _handleSocketClose = function(reconnect, code, reason) {
        delete subscriptions[this.endpoint];
        options.log('WebSocket closed: '+this.endpoint+
            (code ? ' ('+code+')' : '')+
            (reason ? ' '+reason : '')
        );
        if ( options.reconnect && this.reconnect && reconnect ) {
            if ( parseInt(this.endpoint.length, 10) === 60 ) options.log('Account data WebSocket reconnecting...');
            else options.log('WebSocket reconnecting: '+this.endpoint+'...');
            try {
                reconnect();
            } catch ( error ) {
                options.log('WebSocket reconnect error: '+error.message);
            }
        }
    };
    const _handleSocketError = function(error) {
        // Errors ultimately result in a `close` event.
        // see: https://github.com/websockets/ws/blob/828194044bf247af852b31c49e2800d557fedeff/lib/websocket.js#L126
        options.log('WebSocket error: '+this.endpoint+
            (error.code ? ' ('+error.code+')' : '')+
            (error.message ? ' '+error.message : '')
        );
    };
    const _handleSocketHeartbeat = function() {
        this.isAlive = true;
    };
    // reworked Tuitio's heartbeat code into a shared single interval tick
    const noop = function() {};
    const socketHeartbeatInterval = setInterval(function socketHeartbeat() {
        // sockets removed from `subscriptions` during a manual terminate()
        // will no longer be at risk of having functions called on them
        for ( let endpointId in subscriptions ) {
            const ws = subscriptions[endpointId];
            if ( ws.isAlive ) {
                ws.isAlive = false;
                if ( ws.readyState === WebSocket.OPEN) ws.ping(noop);
            } else {
                if ( options.verbose ) options.log("Terminating inactive/broken WebSocket: "+ws.endpoint);
                if ( ws.readyState === WebSocket.OPEN) ws.terminate();
            }
        }
    }, 30000);
    const subscribe = function(endpoint, callback, reconnect = false) {
        if ( options.verbose ) options.log("Subscribed to "+endpoint);
        const ws = new WebSocket(stream+endpoint);
        ws.reconnect = options.reconnect;
        ws.endpoint = endpoint;
        ws.isAlive = false;
        ws.on('open', function() {
            //options.log('subscribe('+this.endpoint+')');
            this.isAlive = true;
            subscriptions[this.endpoint] = this;
        });
        ws.on('pong', _handleSocketHeartbeat);
        ws.on('error', _handleSocketError);
        ws.on('close', _handleSocketClose.bind(ws, reconnect));
        ws.on('message', function(data) {
            try {
                callback(JSON.parse(data));
            } catch (error) {
                options.log('Parse error: '+error.message);
            }
        });
        return ws;
    };
    const subscribeCombined = function(streams, callback, reconnect = false) {
        const queryParams = streams.join('/');
        const ws = new WebSocket(combineStream+queryParams);
        ws.reconnect = options.reconnect;
        ws.endpoint = stringHash(queryParams);
        ws.isAlive = false;
        if ( options.verbose ) options.log('CombinedStream: Subscribed to ['+ws.endpoint+'] '+queryParams);
        ws.on('open', function() {
            //options.log('CombinedStream: WebSocket connection open: '+this.endpoint, queryParms);
            this.isAlive = true;
            subscriptions[this.endpoint] = this;
        });
        ws.on('pong', _handleSocketHeartbeat);
        ws.on('error', _handleSocketError);
        ws.on('close', _handleSocketClose.bind(ws, reconnect));
        ws.on('message', function(data) {
            try {
                callback(JSON.parse(data).data);
            } catch (error) {
                options.log('CombinedStream: Parse error: '+error.message);
            }
        });
        return ws;
    };
    const userDataHandler = function(data) {
        let type = data.e;
        if ( type === 'outboundAccountInfo' ) {
            options.balance_callback(data);
        } else if ( type === 'executionReport' ) {
            if ( options.execution_callback ) options.execution_callback(data);
        } else {
            options.log('Unexpected userData: '+type);
        }
    };
    const prevDayStreamHandler = function(data, callback) {
        let {
            e:eventType,
            E:eventTime,
            s:symbol,
            p:priceChange,
            P:percentChange,
            w:averagePrice,
            x:prevClose,
            c:close,
            Q:closeQty,
            b:bestBid,
            B:bestBidQty,
            a:bestAsk,
            A:bestAskQty,
            o:open,
            h:high,
            l:low,
            v:volume,
            q:quoteVolume,
            O:openTime,
            C:closeTime,
            F:firstTradeId,
            L:lastTradeId,
            n:numTrades
        } = data;
        callback(null, {
            eventType,
            eventTime,
            symbol,
            priceChange,
            percentChange,
            averagePrice,
            prevClose,
            close,
            closeQty,
            bestBid,
            bestBidQty,
            bestAsk,
            bestAskQty,
            open,
            high,
            low,
            volume,
            quoteVolume,
            openTime,
            closeTime,
            firstTradeId,
            lastTradeId,
            numTrades
        });
    };
    ////////////////////////////
    const priceData = function(data) {
        const prices = {};
        if ( Array.isArray(data) ) {
            for ( let obj of data ) {
                prices[obj.symbol] = obj.price;
            }
        } else { // Single price returned
            prices[data.symbol] = data.price;
        }
        return prices;
    };
    const bookPriceData = function(data) {
        let prices = {};
        for ( let obj of data ) {
            prices[obj.symbol] = {
                bid:obj.bidPrice,
                bids:obj.bidQty,
                ask:obj.askPrice,
                asks:obj.askQty
            };
        }
        return prices;
    };
    const balanceData = function(data) {
        let balances = {};
        if ( typeof data === 'undefined' ) return {};
        if ( typeof data.balances === 'undefined' ) {
            options.log('balanceData error', data);
            return {};
        }
        for ( let obj of data.balances ) {
            balances[obj.asset] = {available:obj.free, onOrder:obj.locked};
        }
        return balances;
    };
    const klineData = function(symbol, interval, ticks) { // Used for /depth
        let last_time = 0;
        for ( let tick of ticks ) {
            // eslint-disable-next-line no-unused-vars
            let [time, open, high, low, close, volume, closeTime, assetVolume, trades, buyBaseVolume, buyAssetVolume, ignored] = tick;
            ohlc[symbol][interval][time] = {open:open, high:high, low:low, close:close, volume:volume};
            last_time = time;
        }
        info[symbol][interval].timestamp = last_time;
    };
    const klineConcat = function(symbol, interval) { // Combine all OHLC data with latest update
        let output = ohlc[symbol][interval];
        if ( typeof ohlcLatest[symbol][interval].time === 'undefined' ) return output;
        const time = ohlcLatest[symbol][interval].time;
        const last_updated = Object.keys(ohlc[symbol][interval]).pop();
        if ( time >= last_updated ) {
            output[time] = ohlcLatest[symbol][interval];
            delete output[time].time;
            output[time].isFinal = false;
        }
        return output;
    };
    const klineHandler = function(symbol, kline, firstTime = 0) { // Used for websocket @kline
        // TODO: add Taker buy base asset volume
        // eslint-disable-next-line no-unused-vars
        let { e:eventType, E:eventTime, k:ticks } = kline;
        // eslint-disable-next-line no-unused-vars
        let { o:open, h:high, l:low, c:close, v:volume, i:interval, x:isFinal, q:quoteVolume, t:time } = ticks; //n:trades, V:buyVolume, Q:quoteBuyVolume
        if ( time <= firstTime ) return;
        if ( !isFinal ) {
            if ( typeof ohlcLatest[symbol][interval].time !== 'undefined' ) {
                if ( ohlcLatest[symbol][interval].time > time ) return;
            }
            ohlcLatest[symbol][interval] = {open:open, high:high, low:low, close:close, volume:volume, time:time};
            return;
        }
        // Delete an element from the beginning so we don't run out of memory
        const first_updated = Object.keys(ohlc[symbol][interval]).shift();
        if ( first_updated ) delete ohlc[symbol][interval][first_updated];
        ohlc[symbol][interval][time] = {open:open, high:high, low:low, close:close, volume:volume};
    };
    const depthData = function(data) { // Used for /depth endpoint
        if ( !data ) return {bids:[], asks:[]};
        let bids = {}, asks = {}, obj;
        if ( typeof data.bids !== 'undefined' ) {
            for ( obj of data.bids ) {
                bids[obj[0]] = parseFloat(obj[1]);
            }
        }
        if ( typeof data.asks !== 'undefined' ) {
            for ( obj of data.asks ) {
                asks[obj[0]] = parseFloat(obj[1]);
            }
        }
        return {bids:bids, asks:asks};
    }
    const depthHandler = function(depth, firstUpdateId = 0) { // Used for websocket @depth
        let symbol = depth.s, obj;
        if ( depth.u <= firstUpdateId ) return;
        for ( obj of depth.b ) { //bids
            depthCache[symbol].bids[obj[0]] = parseFloat(obj[1]);
            if ( obj[1] === '0.00000000' ) {
                delete depthCache[symbol].bids[obj[0]];
            }
        }
        for ( obj of depth.a ) { //asks
            depthCache[symbol].asks[obj[0]] = parseFloat(obj[1]);
            if ( obj[1] === '0.00000000' ) {
                delete depthCache[symbol].asks[obj[0]];
            }
        }
    };
    const getDepthCache = function(symbol) {
        if ( typeof depthCache[symbol] === 'undefined' ) return {bids: {}, asks: {}};
        return depthCache[symbol];
    };
    const depthVolume = function(symbol) { // Calculate Buy/Sell volume from DepthCache
        let cache = getDepthCache(symbol), quantity, price;
        let bidbase = 0, askbase = 0, bidqty = 0, askqty = 0;
        for ( price in cache.bids ) {
            quantity = cache.bids[price];
            bidbase+= parseFloat((quantity * parseFloat(price)).toFixed(8));
            bidqty+= quantity;
        }
        for ( price in cache.asks ) {
            quantity = cache.asks[price];
            askbase+= parseFloat((quantity * parseFloat(price)).toFixed(8));
            askqty+= quantity;
        }
        return {bids: bidbase, asks: askbase, bidQty: bidqty, askQty: askqty};
    };
    // Checks whether or not an array contains any duplicate elements
    // Note(keith1024): at the moment this only works for primitive types,
    // will require modification to work with objects
    const isArrayUnique = function(array) {
        return array.every(function(el, pos, arr) {
            return arr.indexOf(el) === pos;
        });
    };
    ////////////////////////////
    return {
        depthCache: function(symbol) {
            return getDepthCache(symbol);
        },
        depthVolume: function(symbol) {
            return depthVolume(symbol);
        },
        roundStep: function roundStep(number, stepSize) {
            return ( (number / stepSize) | 0 ) * stepSize;
        },
        percent: function(min, max, width = 100) {
            return ( min * 0.01 ) / ( max * 0.01 ) * width;
        },
        sum: function(array) {
            return array.reduce((a, b) => a + b, 0);
        },
        reverse: function(object) {
            let range = Object.keys(object).reverse(), output = {};
            for ( let price of range ) {
                output[price] = object[price];
            }
            return output;
        },
        array: function(obj) {
            return Object.keys(obj).map(function(key) {
                return [Number(key), obj[key]];
            });
        },
        sortBids: function(symbol, max = Infinity, baseValue = false) {
            let object = {}, count = 0, cache;
            if ( typeof symbol === 'object' ) cache = symbol;
            else cache = getDepthCache(symbol).bids;
            let sorted = Object.keys(cache).sort(function(a, b){return parseFloat(b)-parseFloat(a)});
            let cumulative = 0;
            for ( let price of sorted ) {
                if ( baseValue === 'cumulative' ) {
                    cumulative+= parseFloat(cache[price]);
                    object[price] = cumulative;
                } else if ( !baseValue ) object[price] = parseFloat(cache[price]);
                else object[price] = parseFloat((cache[price] * parseFloat(price)).toFixed(8));
                if ( ++count >= max ) break;
            }
            return object;
        },
        sortAsks: function(symbol, max = Infinity, baseValue = false) {
            let object = {}, count = 0, cache;
            if ( typeof symbol === 'object' ) cache = symbol;
            else cache = getDepthCache(symbol).asks;
            let sorted = Object.keys(cache).sort(function(a, b){return parseFloat(a)-parseFloat(b)});
            let cumulative = 0;
            for ( let price of sorted ) {
                if ( baseValue === 'cumulative' ) {
                    cumulative+= parseFloat(cache[price]);
                    object[price] = cumulative;
                } else if ( !baseValue ) object[price] = parseFloat(cache[price]);
                else object[price] = parseFloat((cache[price] * parseFloat(price)).toFixed(8));
                if ( ++count >= max ) break;
            }
            return object;
        },
        first: function(object) {
            return Object.keys(object).shift();
        },
        last: function(object) {
            return Object.keys(object).pop();
        },
        slice: function(object, start = 0) {
            return Object.entries(object).slice(start).map(entry => entry[0]);
        },
        min: function(object) {
            return Math.min.apply(Math, Object.keys(object));
        },
        max: function(object) {
            return Math.max.apply(Math, Object.keys(object));
        },
        setOption: function(key, value) {
            options[key] = value;
        },
        options: function(opt, callback = false) {
            options = opt;
            if ( typeof options.recvWindow === 'undefined' ) options.recvWindow = default_options.recvWindow;
            if ( typeof options.useServerTime === 'undefined' ) options.useServerTime = default_options.useServerTime;
            if ( typeof options.reconnect === 'undefined' ) options.reconnect = default_options.reconnect;
            if ( typeof options.test === 'undefined' ) options.test = default_options.test;
            if ( typeof options.log === 'undefined' ) options.log = default_options.log;
            if ( typeof options.verbose === 'undefined' ) options.verbose = default_options.verbose;
            if ( options.useServerTime ) {
                apiRequest(base+'v1/time', function(error, response) {
                    info.timeOffset = response.serverTime - new Date().getTime();
                    //options.log("server time set: ", response.serverTime, info.timeOffset);
                    if ( callback ) callback();
                });
            } else {
                if ( callback ) callback();
            }
        },
        buy: function(symbol, quantity, price, flags = {}, callback = false) {
            order('BUY', symbol, quantity, price, flags, callback);
        },
        sell: function(symbol, quantity, price, flags = {}, callback = false) {
            order('SELL', symbol, quantity, price, flags, callback);
        },
        marketBuy: function(symbol, quantity, flags = {type:'MARKET'}, callback = false) {
            if ( typeof flags === 'function' ) { // Accept callback as third parameter
                callback = flags;
                flags = {type:'MARKET'};
            }
            if ( typeof flags.type == 'undefined' ) flags.type = 'MARKET';
            order('BUY', symbol, quantity, 0, flags, callback);
        },
        marketSell: function(symbol, quantity, flags = {type:'MARKET'}, callback = false) {
            if ( typeof flags === 'function' ) { // Accept callback as third parameter
                callback = flags;
                flags = {type:'MARKET'};
            }
            if ( typeof flags.type == 'undefined' ) flags.type = 'MARKET';
            order('SELL', symbol, quantity, 0, flags, callback);
        },
        cancel: function(symbol, orderid, callback = false) {
            signedRequest(base+'v3/order', {symbol:symbol, orderId:orderid}, function(error, data) {
                if ( callback ) return callback.call(this, error, data, symbol);
            }, 'DELETE');
        },
        orderStatus: function(symbol, orderid, callback, flags = {}) {
            let parameters = Object.assign({symbol:symbol, orderId:orderid}, flags);
            signedRequest(base+'v3/order', parameters, function(error, data) {
                if ( callback ) return callback.call(this, error, data, symbol);
            });
        },
        openOrders: function(symbol, callback) {
            let parameters = symbol ? {symbol:symbol} : {};
            signedRequest(base+'v3/openOrders', parameters, function(error, data) {
                return callback.call(this, error, data, symbol);
            });
        },
        cancelOrders: function(symbol, callback = false) {
            signedRequest(base+'v3/openOrders', {symbol:symbol}, function(error, json) {
                for ( let obj of json ) {
                    let quantity = obj.origQty - obj.executedQty;
                    options.log('cancel order: '+obj.side+' '+symbol+' '+quantity+' @ '+obj.price+' #'+obj.orderId);
                    signedRequest(base+'v3/order', {symbol:symbol, orderId:obj.orderId}, function(error, data) {
                        if ( callback ) return callback.call(this, error, data, symbol);
                    }, 'DELETE');
                }
            });
        },
        allOrders: function(symbol, callback, options = {}) {
            let parameters = Object.assign({symbol:symbol}, options);
            signedRequest(base+'v3/allOrders', parameters, function(error, data) {
                if ( callback ) return callback.call(this, error, data, symbol);
            });
        },
        depth: function(symbol, callback, limit = 100) {
            publicRequest(base+'v1/depth', {symbol:symbol, limit:limit}, function(error, data) {
                return callback.call(this, error, depthData(data), symbol);
            });
        },
        prices: function(symbol, callback = false) {
            const params = typeof symbol === 'string' ? '?symbol='+symbol : '';
            if ( typeof symbol === 'function' ) callback = symbol; // backwards compatibility
            request(base+'v3/ticker/price'+params, function(error, response, body) {
                if ( !callback ) return;

                if ( error )
                    return callback( error );

                if ( response && response.statusCode !== 200 )
                    return callback( response );

                if ( callback )
                    return callback( null, priceData(JSON.parse(body)) );
            });
        },
        bookTickers: function(callback) {
            request(base+'v3/ticker/bookTicker', function(error, response, body) {
                if ( !callback ) return;

                if ( error )
                    return callback( error );

                if ( response && response.statusCode !== 200 )
                    return callback( response );

                if ( callback )
                    return callback( null, bookPriceData(JSON.parse(body)) );
            });
        },
        prevDay: function(symbol, callback) {
            let input = symbol ? {symbol:symbol} : {};
            publicRequest(base+'v1/ticker/24hr', input, function(error, data) {
                if ( callback ) return callback.call(this, error, data, symbol);
            });
        },
        exchangeInfo: function(callback) {
            publicRequest(base+'v1/exchangeInfo', {}, callback);
        },
        systemStatus: function(callback) {
            publicRequest(wapi+'v3/systemStatus.html', {}, callback);
        },
        withdraw: function(asset, address, amount, addressTag = false, callback = false) {
            let params = {asset, address, amount};
            params.name = 'API Withdraw';
            if ( addressTag ) params.addressTag = addressTag;
            signedRequest(wapi+'v3/withdraw.html', params, callback, 'POST');
        },
        withdrawHistory: function(callback, asset = false) {
            let params = asset ? {asset:asset} : {};
            signedRequest(wapi+'v3/withdrawHistory.html', params, callback);
        },
        depositHistory: function(callback, asset = false) {
            let params = asset ? {asset:asset} : {};
            signedRequest(wapi+'v3/depositHistory.html', params, callback);
        },
        depositAddress: function(asset, callback) {
            signedRequest(wapi+'v3/depositAddress.html', {asset:asset}, callback);
        },
        accountStatus: function(callback) {
            signedRequest(wapi+'v3/accountStatus.html', {}, callback);
        },
        account: function(callback) {
            signedRequest(base+'v3/account', {}, callback);
        },
        balance: function(callback) {
            signedRequest(base+'v3/account', {}, function(error, data) {
                if ( callback ) callback( error, balanceData(data) );
            });
        },
        trades: function(symbol, callback, options = {}) {
            let parameters = Object.assign({symbol:symbol}, options);
            signedRequest(base+'v3/myTrades', parameters, function(error, data) {
                if ( callback ) return callback.call(this, error, data, symbol);
            });
        },
        useServerTime: function(callback = false) {
            apiRequest(base+'v1/time', function(error, response) {
                info.timeOffset = response.serverTime - new Date().getTime();
                //options.log("server time set: ", response.serverTime, info.timeOffset);
                if ( callback ) callback();
            });
        },
        time: function(callback) {
            apiRequest(base+'v1/time', callback);
        },
        aggTrades: function(symbol, options = {}, callback = false) { //fromId startTime endTime limit
            let parameters = Object.assign({symbol}, options);
            marketRequest(base+'v1/aggTrades', parameters, callback);
        },
        recentTrades: function(symbol, callback, limit = 500) {
            marketRequest(base+'v1/trades', {symbol:symbol, limit:limit}, callback);
        },
        historicalTrades: function(symbol, callback, limit = 500, fromId = false) {
            let parameters = {symbol:symbol, limit:limit};
            if ( fromId ) parameters.fromId = fromId;
            marketRequest(base+'v1/historicalTrades', parameters, callback);
        },
        // convert chart data to highstock array [timestamp,open,high,low,close]
        highstock: function(chart, include_volume = false) {
            let array = [];
            for ( let timestamp in chart ) {
                let obj = chart[timestamp];
                let line = [
                    Number(timestamp),
                    parseFloat(obj.open),
                    parseFloat(obj.high),
                    parseFloat(obj.low),
                    parseFloat(obj.close)
                ];
                if ( include_volume ) line.push(parseFloat(obj.volume));
                array.push(line);
            }
            return array;
        },
        ohlc: function(chart) {
            let open = [], high = [], low = [], close = [], volume = [];
            for ( let timestamp in chart ) { //ohlc[symbol][interval]
                let obj = chart[timestamp];
                open.push(parseFloat(obj.open));
                high.push(parseFloat(obj.high));
                low.push(parseFloat(obj.low));
                close.push(parseFloat(obj.close));
                volume.push(parseFloat(obj.volume));
            }
            return {open:open, high:high, low:low, close:close, volume:volume};
        },
        // intervals: 1m,3m,5m,15m,30m,1h,2h,4h,6h,8h,12h,1d,3d,1w,1M
        candlesticks: function(symbol, interval = '5m', callback = false, options = {limit:500}) {
            if ( !callback ) return;
            let params = Object.assign({symbol:symbol, interval:interval}, options);
            publicRequest(base+'v1/klines', params, function(error, data) {
                return callback.call(this, error, data, symbol);
            });
        },
        publicRequest: function(url, data, callback, method = 'GET') {
            publicRequest(url, data, callback, method)
        },
        signedRequest: function(url, data, callback, method = 'GET') {
            signedRequest(url, data, callback, method);
        },
        getMarket: function(symbol) {
            const substring = symbol.substr(-3);
            if ( substring === 'BTC' ) return 'BTC';
            else if ( substring === 'ETH' ) return 'ETH';
            else if ( substring === 'BNB' ) return 'BNB';
            else if ( symbol.substr(-4) === 'USDT' ) return 'USDT';
        },
        websockets: {
            userData: function userData(callback, execution_callback = false, subscribed_callback = false) {
                let reconnect = function() {
                    if ( options.reconnect ) userData(callback, execution_callback);
                };
                apiRequest(base+'v1/userDataStream', function(error, response) {
                    options.listenKey = response.listenKey;
                    setInterval(function() { // keepalive
                        try {
                            apiRequest(base+'v1/userDataStream?listenKey='+options.listenKey, false, 'PUT');
                        } catch ( error ) {
                            //error.message
                        }
                    }, 60 * 30 * 1000); // 30 minute keepalive
                    options.balance_callback = callback;
                    options.execution_callback = execution_callback;
                    const subscription = subscribe(options.listenKey, userDataHandler, reconnect);
                    if ( subscribed_callback ) subscribed_callback(subscription.endpoint);
                },'POST');
            },
            subscribe: function(url, callback, reconnect = false) {
                return subscribe(url, callback, reconnect);
            },
            subscriptions: function() {
                return subscriptions;
            },
            terminate: function(endpoint) {
                let ws = subscriptions[endpoint];
                if ( !ws ) return;
                options.log('WebSocket terminated:', endpoint);
                ws.reconnect = false;
                ws.terminate();
            },
            depth: function depth(symbols, callback) {
                let reconnect = function() {
                    if ( options.reconnect ) depth(symbols, callback);
                };

                let subscription = undefined;
                if ( Array.isArray(symbols) ) {
                    if ( !isArrayUnique(symbols) ) throw Error('depth: "symbols" cannot contain duplicate elements.');
                    let streams = symbols.map(function(symbol) {
                        return symbol.toLowerCase()+'@depth';
                    });
                    subscription = subscribeCombined(streams, callback, reconnect);
                } else {
                    let symbol = symbols;
                    subscription = subscribe(symbol.toLowerCase()+'@depth', callback, reconnect);
                }
                return subscription.endpoint;
            },
            depthCache: function depthCacheFunction(symbols, callback, limit = 500) {
                let reconnect = function() {
                    if ( options.reconnect ) depthCacheFunction(symbols, callback);
                };

                let symbolDepthInit = function(symbol) {
                    if ( typeof info[symbol] === 'undefined' )
                        info[symbol] = {};

                    info[symbol].firstUpdateId = 0;
                    depthCache[symbol] = { bids: {}, asks: {} };
                    messageQueue[symbol] = [];
                };

                let handleDepthStreamData = function(depth) {
                    let symbol = depth.s;
                    if ( !info[symbol].firstUpdateId ) {
                        messageQueue[symbol].push(depth);
                    } else {
                        depthHandler(depth);
                        if ( callback ) callback(symbol, depthCache[symbol]);
                    }
                };

                let getSymbolDepthSnapshot = function(symbol, index) {
                    publicRequest(base+'v1/depth', { symbol:symbol, limit:limit }, function(error, json) {
                        info[symbol].firstUpdateId = json.lastUpdateId;
                        depthCache[symbol] = depthData(json);
                        // Process any pending depth messages
                        if ( typeof messageQueue[symbol] !== 'undefined' ) {
                            for ( let depth of messageQueue[symbol] )
                                depthHandler(depth, json.lastUpdateId);
                            delete messageQueue[symbol];
                        }
                        if ( callback ) callback(symbol, depthCache[symbol]);
                    });
                };
                // If an array of symbols are sent we use a combined stream connection rather.
                // This is transparent to the developer, and results in a single socket connection.
                // This essentially eliminates "unexpected response" errors when subscribing to a lot of data.
                let subscription = undefined;
                if ( Array.isArray(symbols) ) {
                    if ( !isArrayUnique(symbols) ) throw Error('depthCache: "symbols" cannot contain duplicate elements.');

                    symbols.forEach(symbolDepthInit);
                    let streams = symbols.map(function (symbol) {
                        return symbol.toLowerCase()+'@depth';
                    });
                    subscription = subscribeCombined(streams, handleDepthStreamData, reconnect);
                    symbols.forEach(getSymbolDepthSnapshot);
                } else {
                    let symbol = symbols;
                    symbolDepthInit(symbol);
                    subscription = subscribe(symbol.toLowerCase()+'@depth', handleDepthStreamData, reconnect);
                    getSymbolDepthSnapshot(symbol);
                }
                return subscription.endpoint;
            },
            trades: function trades(symbols, callback) {
                let reconnect = function() {
                    if ( options.reconnect ) trades(symbols, callback);
                };

                let subscription = undefined;
                if ( Array.isArray(symbols) ) {
                    if ( !isArrayUnique(symbols) ) throw Error('trades: "symbols" cannot contain duplicate elements.');
                    let streams = symbols.map(function(symbol) {
                        return symbol.toLowerCase()+'@aggTrade';
                    });
                    subscription = subscribeCombined(streams, callback, reconnect);
                } else {
                    let symbol = symbols;
                    subscription = subscribe(symbol.toLowerCase()+'@aggTrade', callback, reconnect);
                }
                return subscription.endpoint;
            },
            chart: function chart(symbols, interval, callback) {
                let reconnect = function() {
                    if ( options.reconnect ) chart(symbols, interval, callback);
                };

                let symbolChartInit = function(symbol) {
                    if ( typeof info[symbol] === 'undefined' ) info[symbol] = {};
                    if ( typeof info[symbol][interval] === 'undefined' ) info[symbol][interval] = {};
                    if ( typeof ohlc[symbol] === 'undefined' ) ohlc[symbol] = {};
                    if ( typeof ohlc[symbol][interval] === 'undefined' ) ohlc[symbol][interval] = {};
                    if ( typeof ohlcLatest[symbol] === 'undefined' ) ohlcLatest[symbol] = {};
                    if ( typeof ohlcLatest[symbol][interval] === 'undefined' ) ohlcLatest[symbol][interval] = {};
                    if ( typeof klineQueue[symbol] === 'undefined' ) klineQueue[symbol] = {};
                    if ( typeof klineQueue[symbol][interval] === 'undefined' ) klineQueue[symbol][interval] = [];
                    info[symbol][interval].timestamp = 0;
                }

                let handleKlineStreamData = function(kline) {
                    let symbol = kline.s;
                    if ( !info[symbol][interval].timestamp ) {
                        klineQueue[symbol][interval].push(kline);
                    } else {
                        //options.log('@klines at ' + kline.k.t);
                        klineHandler(symbol, kline);
                        if ( callback ) callback(symbol, interval, klineConcat(symbol, interval));
                    }
                };

                let getSymbolKlineSnapshot = function(symbol) {
                    publicRequest(base + 'v1/klines', { symbol:symbol, interval:interval }, function (error, data) {
                        klineData(symbol, interval, data);
                        //options.log('/klines at ' + info[symbol][interval].timestamp);
                        if ( typeof klineQueue[symbol][interval] !== 'undefined' ) {
                            for ( let kline of klineQueue[symbol][interval] )
                                klineHandler(symbol, kline, info[symbol][interval].timestamp);
                            delete klineQueue[symbol][interval];
                        }
                        if ( callback ) callback(symbol, interval, klineConcat(symbol, interval));
                    });
                };

                let subscription = undefined;
                if ( Array.isArray(symbols) ) {
                    if ( !isArrayUnique(symbols) ) throw Error('chart: "symbols" cannot contain duplicate elements.');
                    symbols.forEach(symbolChartInit);
                    let streams = symbols.map(function(symbol) {
                        return symbol.toLowerCase()+`@kline_`+interval;
                    });
                    subscription = subscribeCombined(streams, handleKlineStreamData, reconnect);
                    symbols.forEach(getSymbolKlineSnapshot);
                } else {
                    let symbol = symbols;
                    symbolChartInit(symbol);
                    subscription = subscribe(symbol.toLowerCase()+'@kline_'+interval, handleKlineStreamData, reconnect);
                    getSymbolKlineSnapshot(symbol);
                }
                return subscription.endpoint;
            },
            candlesticks: function candlesticks(symbols, interval, callback) {
                let reconnect = function() {
                    if ( options.reconnect ) candlesticks(symbols, interval, callback);
                };
                // If an array of symbols are sent we use a combined stream connection rather.
                // This is transparent to the developer, and results in a single socket connection.
                // This essentially eliminates "unexpected response" errors when subscribing to a lot of data.
                let subscription = undefined;
                if ( Array.isArray(symbols) ) {
                    if ( !isArrayUnique(symbols) ) throw Error('candlesticks: "symbols" cannot contain duplicate elements.');
                    let streams = symbols.map(function (symbol) {
                        return symbol.toLowerCase()+'@kline_'+interval;
                    });
                    subscription = subscribeCombined(streams, callback, reconnect);
                } else {
                    let symbol = symbols.toLowerCase();
                    subscription = subscribe(symbol+'@kline_'+interval, callback, reconnect);
                }
                return subscription.endpoint;
            },
            prevDay: function prevDay(symbols, callback) {
                let reconnect = function() {
                    if ( options.reconnect ) prevDay(symbols, callback);
                };

                let subscription = undefined;
                // Combine stream for array of symbols
                if ( Array.isArray(symbols) ) {
                    if ( !isArrayUnique(symbols) ) throw Error('prevDay: "symbols" cannot contain duplicate elements.');
                    let streams = symbols.map(function(symbol) {
                        return symbol.toLowerCase()+'@ticker';
                    });
                    subscription = subscribeCombined(streams, function(data) {
                        prevDayStreamHandler(data, callback);
                    }, reconnect);
                // Raw stream for  a single symbol
                } else if ( symbols ) {
                    let symbol = symbols;
                    subscription = subscribe(symbol.toLowerCase()+'@ticker', function(data) {
                        prevDayStreamHandler(data, callback);
                    }, reconnect);
                // Raw stream of all listed symbols
                } else {
                    subscription = subscribe('!ticker@arr', function(data) {
                        for ( let line of data ) {
                            prevDayStreamHandler(line, callback);
                        }
                    }, reconnect);
                }
                return subscription.endpoint;
            }
        }
    };
}();
//https://github.com/binance-exchange/binance-official-api-docs
