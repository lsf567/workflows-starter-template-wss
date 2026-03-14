/*
// 当前仅支持 WS 模式的 VLESS 协议。
// ws 模式导入链接：vless://{这里写uuid}@104.16.40.11:2053?encryption=none&security=tls&sni={这里写域名}&alpn=http%2F1.1&fp=chrome&type=ws&host={这里写域名}#vless
// 复制导入链接后按需修改域名、UUID、端口即可。
 * ======================= URL 路径参数速查表 =======================
 * 多个参数用 & 连接，示例：/?ip=1.2.3.4:443
 * ip                       - 直连失败时的备用出口地址                示例: ip=1.2.3.4:443
 * ==================================================================*/
import {DurableObject} from 'cloudflare:workers';
import {connect} from 'cloudflare:sockets';
const defaultEnableHeavyDo = true;
const uuid = '374b719e-1487-49ac-8303-1697301950d6';//vless使用的uuid
const heavyDoShardCount = 1;//仅在显式启用 ENABLE_HEAVY_DO 时生效
const maxHeavyDoShardCount = 4;
// ---------------------------------------------------------------------------------
/** TCPsocket并发获取，可提高tcp连接成功率*/
const concurrentOnlyDomain = false;//只对域名并发开关
/**- **警告**: snippets只能设置为1，worker最大支持6，超过6没意义*/
const concurrency = 1;//socket获取并发数
// ---------------------------------------------------------------------------------
const maxInitialRequestBytes = 4096;
const dohEndpoints = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'];
const dohJsonEndpoints = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
const dohFetchOptions = {method: 'POST', headers: {'content-type': 'application/dns-message'}};
const workerDnsEarlyDataFastPath = true;
const proxyIpAddrs = {EU: 'ProxyIP.DE.CMLiussss.net', AS: 'ProxyIP.JP.CMLiussss.net', JP: 'ProxyIP.JP.CMLiussss.net', US: 'ProxyIP.US.CMLiussss.net'};//分区域备用出口
const finallyProxyHost = 'ProxyIP.CMLiussss.net';//最终兜底出口
const coloRegions = {
    JP: new Set(['FUK', 'ICN', 'KIX', 'NRT', 'OKA']),
    EU: new Set([
        'ACC', 'ADB', 'ALA', 'ALG', 'AMM', 'AMS', 'ARN', 'ATH', 'BAH', 'BCN', 'BEG', 'BGW', 'BOD', 'BRU', 'BTS', 'BUD', 'CAI',
        'CDG', 'CPH', 'CPT', 'DAR', 'DKR', 'DMM', 'DOH', 'DUB', 'DUR', 'DUS', 'DXB', 'EBB', 'EDI', 'EVN', 'FCO', 'FRA', 'GOT',
        'GVA', 'HAM', 'HEL', 'HRE', 'IST', 'JED', 'JIB', 'JNB', 'KBP', 'KEF', 'KWI', 'LAD', 'LED', 'LHR', 'LIS', 'LOS', 'LUX',
        'LYS', 'MAD', 'MAN', 'MCT', 'MPM', 'MRS', 'MUC', 'MXP', 'NBO', 'OSL', 'OTP', 'PMO', 'PRG', 'RIX', 'RUH', 'RUN', 'SKG',
        'SOF', 'STR', 'TBS', 'TLL', 'TLV', 'TUN', 'VIE', 'VNO', 'WAW', 'ZAG', 'ZRH']),
    AS: new Set([
        'ADL', 'AKL', 'AMD', 'BKK', 'BLR', 'BNE', 'BOM', 'CBR', 'CCU', 'CEB', 'CGK', 'CMB', 'COK', 'DAC', 'DEL', 'HAN', 'HKG',
        'HYD', 'ISB', 'JHB', 'JOG', 'KCH', 'KHH', 'KHI', 'KTM', 'KUL', 'LHE', 'MAA', 'MEL', 'MFM', 'MLE', 'MNL', 'NAG', 'NOU',
        'PAT', 'PBH', 'PER', 'PNH', 'SGN', 'SIN', 'SYD', 'TPE', 'ULN', 'VTE'])
};
const coloToProxyMap = new Map(Object.entries(coloRegions).flatMap(([region, colos]) => Array.from(colos, colo => [colo, proxyIpAddrs[region]])));
const uuidBytes = new Uint8Array(16), offsets = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4, 4, 4];
for (let i = 0, c; i < 16; i++) uuidBytes[i] = (((c = uuid.charCodeAt(i * 2 + offsets[i])) > 64 ? c + 9 : c) & 0xF) << 4 | (((c = uuid.charCodeAt(i * 2 + offsets[i] + 1)) > 64 ? c + 9 : c) & 0xF);
const [textEncoder, textDecoder] = [new TextEncoder(), new TextDecoder()];
const html = `<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx/1.25.3</center></body></html>`;
const binaryAddrToString = (addrType, addrBytes) => {
    if (addrType === 3) return textDecoder.decode(addrBytes);
    if (addrType === 1) return `${addrBytes[0]}.${addrBytes[1]}.${addrBytes[2]}.${addrBytes[3]}`;
    if (addrType === 4) {
        let ipv6 = ((addrBytes[0] << 8) | addrBytes[1]).toString(16);
        for (let i = 1; i < 8; i++) ipv6 += ':' + ((addrBytes[i * 2] << 8) | addrBytes[i * 2 + 1]).toString(16);
        return `[${ipv6}]`;
    }
};
const parseHostPort = (addr, defaultPort) => {
    if (addr.startsWith('[')) {
        const sepIndex = addr.indexOf(']:');
        if (sepIndex !== -1) return [addr.substring(0, sepIndex + 1), addr.substring(sepIndex + 2)];
        return [addr, defaultPort];
    }
    const tpIndex = addr.indexOf('.tp');
    const lastColon = addr.lastIndexOf(':');
    if (tpIndex !== -1 && lastColon === -1) return [addr, addr.substring(tpIndex + 3, addr.indexOf('.', tpIndex + 3))];
    if (lastColon === -1) return [addr, defaultPort];
    return [addr.substring(0, lastColon), addr.substring(lastColon + 1)];
};
const isIPv4optimized = (str) => {
    if (str.length > 15 || str.length < 7) return false;
    let part = 0, dots = 0, partLen = 0;
    for (let i = 0; i < str.length; i++) {
        const charCode = str.charCodeAt(i);
        if (charCode === 46) {
            dots++;
            if (dots > 3 || partLen === 0 || (str.charCodeAt(i - 1) === 48 && partLen > 1)) return false;
            part = 0;
            partLen = 0;
        } else if (charCode >= 48 && charCode <= 57) {
            partLen++;
            part = part * 10 + (charCode - 48);
            if (part > 255 || partLen > 3) return false;
        } else {return false}
    }
    return !(dots !== 3 || partLen === 0 || (str.charCodeAt(str.length - partLen) === 48 && partLen > 1));
};
const isDomainName = (inputStr) => {
    if (!concurrentOnlyDomain) return true;
    if (!inputStr || inputStr[0] === '[') return false;
    if (inputStr[0].charCodeAt(0) < 48 || inputStr[0].charCodeAt(0) > 57) return true;
    return !isIPv4optimized(inputStr);
};
const closeSocketQuietly = (socket) => {
    try {socket?.close()} catch {}
};
const closeWebSocketQuietly = (webSocket) => {
    try {webSocket?.close()} catch {}
};
const concatUint8Arrays = (left, right) => {
    const combined = new Uint8Array(left.length + right.length);
    combined.set(left);
    combined.set(right, left.length);
    return combined;
};
const isTruthyFlag = (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value !== 'string') return false;
    switch (value.trim().toLowerCase()) {
        case '1':
        case 'true':
        case 'yes':
        case 'on':
            return true;
        default:
            return false;
    }
};
const isHeavyDoEnabled = (env) => !!env?.HEAVY_DO && isTruthyFlag(env?.ENABLE_HEAVY_DO ?? defaultEnableHeavyDo);
const createConnect = (hostname, port, socket = connect({hostname, port})) => socket.opened.then(() => socket);
const concurrentConnect = (hostname, port, addrType) => {
    if (concurrency === 1 || (concurrentOnlyDomain && addrType !== 3)) return createConnect(hostname, port);
    return Promise.any(Array(concurrency).fill(null).map(() => createConnect(hostname, port)));
};
const connectAny = async (targets) => {
    const attempts = targets.map(({host, port}) => {
        const socket = connect({hostname: host, port});
        const ready = socket.opened.then(() => socket).catch(error => {
            closeSocketQuietly(socket);
            throw error;
        });
        return {socket, ready};
    });
    try {
        const winner = await Promise.any(attempts.map(attempt => attempt.ready));
        for (const attempt of attempts) {
            if (attempt.socket !== winner) closeSocketQuietly(attempt.socket);
        }
        return winner;
    } catch {
        for (const attempt of attempts) closeSocketQuietly(attempt.socket);
        return null;
    }
};
const parseAddress = (buffer, offset, addrType) => {
    const addressLength = addrType === 3 ? buffer[offset++] : addrType === 1 ? 4 : addrType === 4 ? 16 : null;
    if (addressLength === null) return {status: 'invalid'};
    const newOffset = offset + addressLength;
    if (newOffset > buffer.length) return {status: 'incomplete'};
    const targetAddrBytes = buffer.subarray(offset, newOffset);
    return {status: 'ok', targetAddrBytes, dataOffset: newOffset};
};
const parseRequestDataState = (firstChunk) => {
    if (firstChunk.length < 24) return {status: 'incomplete'};
    for (let i = 0; i < 16; i++) if (firstChunk[i + 1] !== uuidBytes[i]) return {status: 'invalid'};
    let offset = 19 + firstChunk[17];
    if (offset + 3 > firstChunk.length) return {status: 'incomplete'};
    const port = (firstChunk[offset] << 8) | firstChunk[offset + 1];
    let addrType = firstChunk[offset + 2];
    if (addrType !== 1) addrType += 1;
    const addressInfo = parseAddress(firstChunk, offset + 3, addrType);
    if (addressInfo.status !== 'ok') return addressInfo;
    return {status: 'ok', parsedRequest: {addrType, targetAddrBytes: addressInfo.targetAddrBytes, dataOffset: addressInfo.dataOffset, port, isDns: port === 53}};
};
const parseRequestData = (firstChunk) => {
    const parseResult = parseRequestDataState(firstChunk);
    return parseResult.status === 'ok' ? parseResult.parsedRequest : null;
};
const concurrentDnsResolve = async (hostname, recordType) => {
    try {
        const dnsResult = await Promise.any(dohJsonEndpoints.map(endpoint =>
            fetch(`${endpoint}?name=${hostname}&type=${recordType}`, {headers: {'Accept': 'application/dns-json'}}).then(response => {
                if (!response.ok) throw new Error();
                return response.json();
            })
        ));
        const answer = dnsResult.Answer || dnsResult.answer;
        if (!answer || answer.length === 0) return null;
        return answer;
    } catch {return null}
};
const williamResult = async (william) => {
    const answer = await concurrentDnsResolve(william, 'TXT');
    if (!answer) return null;
    const txtRecords = answer.filter(record => record.type === 16).map(record => record.data);
    if (txtRecords.length === 0) return null;
    let txtData = txtRecords[0];
    if (txtData.startsWith('"') && txtData.endsWith('"')) txtData = txtData.slice(1, -1);
    const prefixes = txtData.replace(/\\010/g, ',').replace(/\n/g, ',').split(',').map(s => s.trim()).filter(Boolean);
    if (prefixes.length === 0) return null;
    return prefixes;
};
const connectProxyIp = async (param) => {
    if (param.includes('.william')) {
        const resolvedIps = await williamResult(param);
        if (!resolvedIps || resolvedIps.length === 0) return null;
        const targets = resolvedIps.map(ip => {
            const [host, port] = parseHostPort(ip, 443);
            return {host, port};
        });
        return connectAny(targets);
    }
    const [host, port] = parseHostPort(param, 443);
    const addrType = isDomainName(host) ? 3 : 0;
    return concurrentConnect(host, port, addrType);
};
const parseConnectionParams = (requestUrl) => {
    const ip = new URL(requestUrl).searchParams.get('ip');
    return ip ? {ip} : {};
};
const connectDirect = ({addrType, port, targetAddrBytes}) => {
    const hostname = binaryAddrToString(addrType, targetAddrBytes);
    return concurrentConnect(hostname, port, addrType);
};
const executeDecodedIpStrategies = async (rawParam) => {
    if (!rawParam) return null;
    const decodedParam = decodeURIComponent(rawParam);
    let itemStart = 0;
    for (let i = 0; i <= decodedParam.length; i++) {
        if (i !== decodedParam.length && decodedParam.charCodeAt(i) !== 44) continue;
        const value = decodedParam.substring(itemStart, i).trim();
        itemStart = i + 1;
        if (!value) continue;
        const tcpSocket = await connectProxyIp(value);
        if (tcpSocket) return tcpSocket;
    }
    return null;
};
const establishTcpConnection = async (parsedRequest, request) => {
    const params = parseConnectionParams(request.url);
    const directSocket = await connectDirect(parsedRequest);
    if (directSocket) return directSocket;
    const proxyIpSocket = await executeDecodedIpStrategies(params.ip);
    if (proxyIpSocket) return proxyIpSocket;
    const regionalProxySocket = await connectProxyIp(coloToProxyMap.get(request.cf?.colo) ?? proxyIpAddrs.US);
    if (regionalProxySocket) return regionalProxySocket;
    return concurrentConnect(finallyProxyHost, 443, 3);
};
const dohDnsHandler = async (payload) => {
    if (payload.byteLength < 2) throw new Error();
    const dnsQueryData = payload.subarray(2);
    const resp = await Promise.any(dohEndpoints.map(endpoint =>
        fetch(endpoint, {...dohFetchOptions, body: dnsQueryData}).then(response => {
            if (!response.ok) throw new Error();
            return response;
        })
    ));
    const dnsQueryResult = await resp.arrayBuffer();
    const udpSize = dnsQueryResult.byteLength;
    const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
    const packet = new Uint8Array(udpSizeBuffer.length + udpSize);
    packet.set(udpSizeBuffer, 0);
    packet.set(new Uint8Array(dnsQueryResult), udpSizeBuffer.length);
    return packet;
};
const getWebSocketEarlyData = (request) => {
    const protocolHeader = request.headers.get('sec-websocket-protocol');
    if (!protocolHeader) return null;
    try {
        // @ts-ignore
        return Uint8Array.fromBase64(protocolHeader, {alphabet: 'base64url'});
    } catch {return null}
};
const normalizeWsChunk = (chunk) => chunk instanceof Uint8Array ? chunk : typeof chunk === 'string' ? textEncoder.encode(chunk) : new Uint8Array(chunk);
const handleWebSocketConn = async (webSocket, request, earlyData = getWebSocketEarlyData(request)) => {
    let streamClosed = false;
    let pendingFirstChunk = null;
    const webSocketStream = new ReadableStream({
        start(controller) {
            if (earlyData) controller.enqueue(earlyData);
            webSocket.addEventListener("message", event => controller.enqueue(normalizeWsChunk(event.data)));
            webSocket.addEventListener("close", () => {
                if (streamClosed) return;
                streamClosed = true;
                controller.close();
            });
            webSocket.addEventListener("error", () => {
                if (streamClosed) return;
                streamClosed = true;
                controller.error(new Error('websocket error'));
            });
        },
        cancel() {webSocket.close()}
    });
    let messageHandler, tcpSocket, tcpWriter;
    const closeSocket = () => {
        messageHandler = null;
        try {tcpWriter?.releaseLock()} catch {}
        tcpWriter = null;
        closeSocketQuietly(tcpSocket);
        tcpSocket = null;
        closeWebSocketQuietly(webSocket);
    };
    webSocketStream.pipeTo(new WritableStream({
        async write(chunk) {
            if (messageHandler) return messageHandler(chunk);
            const firstChunk = pendingFirstChunk ? concatUint8Arrays(pendingFirstChunk, chunk) : chunk;
            const parseResult = parseRequestDataState(firstChunk);
            if (parseResult.status === 'incomplete') {
                if (firstChunk.length > maxInitialRequestBytes) throw new Error();
                pendingFirstChunk = firstChunk;
                return;
            }
            if (parseResult.status !== 'ok') throw new Error();
            pendingFirstChunk = null;
            const {parsedRequest} = parseResult;
            webSocket.send(new Uint8Array([firstChunk[0], 0]));
            const payload = firstChunk.subarray(parsedRequest.dataOffset);
            if (parsedRequest.isDns) {
                webSocket.send(await dohDnsHandler(payload));
                webSocket.close();
            } else {
                tcpSocket = await establishTcpConnection(parsedRequest, request);
                if (!tcpSocket) throw new Error();
                tcpWriter = tcpSocket.writable.getWriter();
                if (payload.byteLength) await tcpWriter.write(payload);
                messageHandler = tcpWriter.write.bind(tcpWriter);
                tcpSocket.readable.pipeTo(new WritableStream({write(chunk) {webSocket.send(chunk)}})).catch(() => closeSocket()).finally(() => closeSocket());
            }
        }
    })).catch(() => closeSocket()).finally(() => closeSocket());
};
const isWebSocketUpgrade = (request) => request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
const shouldHandleDnsInWorker = (request, env, earlyData = getWebSocketEarlyData(request)) => {
    if (!workerDnsEarlyDataFastPath || !isHeavyDoEnabled(env) || !isWebSocketUpgrade(request) || !earlyData?.byteLength) return false;
    const parsedRequest = parseRequestData(earlyData);
    return !!parsedRequest?.isDns;
};
const getConfiguredHeavyDoShardCount = (env) => {
    const rawValue = Number.parseInt(env?.HEAVY_DO_SHARDS ?? `${heavyDoShardCount}`, 10);
    if (!Number.isFinite(rawValue)) return heavyDoShardCount;
    return Math.min(maxHeavyDoShardCount, Math.max(1, rawValue));
};
const hashString = (input) => {
    let hash = 0;
    for (let i = 0; i < input.length; i++) hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
    return hash;
};
const getHeavyDoName = (request, env) => {
    const shardCount = getConfiguredHeavyDoShardCount(env);
    if (shardCount <= 1) return 'singleton';
    const clientKey = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || request.headers.get('sec-websocket-key') || 'default';
    return `shard:${hashString(clientKey) % shardCount}`;
};
const shouldOffloadToHeavyDo = (request, env) => isHeavyDoEnabled(env) && isWebSocketUpgrade(request);
const routeToHeavyDo = (request, env) => {
    const id = env.HEAVY_DO.idFromName(getHeavyDoName(request, env));
    return env.HEAVY_DO.get(id).fetch(request);
};
const handleRequest = (request, earlyData = getWebSocketEarlyData(request)) => {
    if (isWebSocketUpgrade(request)) {
        const {0: clientSocket, 1: webSocket} = new WebSocketPair();
        webSocket.accept();
        handleWebSocketConn(webSocket, request, earlyData);
        return new Response(null, {status: 101, webSocket: clientSocket});
    }
    return new Response(html, {status: 404, headers: {'Content-Type': 'text/html; charset=UTF-8'}});
};
export class HeavyDo extends DurableObject {
    async fetch(request) {
        return handleRequest(request);
    }
}
export default {
    async fetch(request, env) {
        const webSocketUpgrade = isWebSocketUpgrade(request);
        const earlyData = webSocketUpgrade ? getWebSocketEarlyData(request) : null;
        if (!webSocketUpgrade || !isHeavyDoEnabled(env)) return handleRequest(request, earlyData);
        if (shouldHandleDnsInWorker(request, env, earlyData)) return handleRequest(request, earlyData);
        if (shouldOffloadToHeavyDo(request, env)) return routeToHeavyDo(request, env);
        return handleRequest(request, earlyData);
    }
};
