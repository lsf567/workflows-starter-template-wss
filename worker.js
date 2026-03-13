/*
// 代码基本都抄的CM和天书大佬的项目，在此感谢各位大佬的无私奉献。
// 当前仅支持 WS 模式的 VLESS 协议。
// ws 模式导入链接：vless://{这里写uuid}@104.16.40.11:2053?encryption=none&security=tls&sni={这里写域名}&alpn=http%2F1.1&fp=chrome&type=ws&host={这里写域名}#vless
// 复制导入链接后按需修改域名、UUID、端口即可。
 * ======================= URL 路径参数速查表 =======================
 * 多个参数用 & 连接，示例：/?s5=host:port&ip=1.2.3.4:443
 * s5 / socks               - 直连失败时使用 SOCKS5 代理              示例: s5=user:pass@host:port
 * gs5 / s5all              - 全局 SOCKS5 代理                        示例: gs5=user:pass@host:port
 * http                     - 直连失败时使用 HTTP 代理                示例: http=user:pass@host:port
 * ghttp / httpall          - 全局 HTTP 代理                          示例: ghttp=user:pass@host:port
 * nat64                    - 直连失败时使用 NAT64                    示例: nat64=64:ff9b::
 * gnat64 / nat64all        - 全局 NAT64                              示例: gnat64=64:ff9b::
 * ip                       - 直连失败时的备用出口地址                示例: ip=1.2.3.4:443
 * proxyall / globalproxy   - 无直连，直接按全局代理顺序出站          示例: proxyall=1
 * ==================================================================*/
import {DurableObject} from 'cloudflare:workers';
import {connect} from 'cloudflare:sockets';
const uuid = '374b719e-1487-49ac-8303-1697301950d6';//vless使用的uuid
const heavyDoShardCount = 1;//默认分片数，免费版建议保持1，避免每条连接独占一个DO导致GB-sec暴涨
const maxHeavyDoShardCount = 4;
// ---------------------------------------------------------------------------------
// 理论最大带宽计算公式 (Theoretical Max Bandwidth Calculation):
//    - 速度上限 (Mbps) = (bufferSize (字节) / flushTime (毫秒)) * 0.008
//    - 示例: (256 * 1024 字节 / 10 毫秒) * 0.008 ≈ 210 Mbps
//    - 在此模式下，这两个参数共同构成了一个精确的速度限制器。
// ---------------------------------------------------------------------------------
/** 下行使用pipe管道开关。true: 启用pipe管道。false: 使用手动循环。*/
const wsDownloadUserPipe = true; //TCP到Websocket下行
/** 缓冲发送模式开关。true: 启用缓冲层，聚合发送可降低发送send()调用开销，但是会增加数据转发延迟。false: 不使用缓冲层。*/
const wsUserBufferer = false;//TCP到Websocket使用缓冲
/** 缓冲区最大大小。用于计算速度上限。*/
const bufferSize = 256 * 1024; // 256KB
/** 发送调用刷新时间(毫秒)。设定固定的发送频率以控制速度。*/
/**- **警告**: 设置过低  会因定时器精度和高频创建/销毁开销导致 CPU 负担加重。*/
const flushTime = 10; // 10ms
// ---------------------------------------------------------------------------------
/** TCPsocket并发获取，可提高tcp连接成功率*/
const concurrentOnlyDomain = false;//只对域名并发开关
/**- **警告**: snippets只能设置为1，worker最大支持6，超过6没意义*/
const concurrency = 1;//socket获取并发数
// ---------------------------------------------------------------------------------
// 三者的 socket 获取顺序；全局模式按这三者依次尝试，非全局模式为：直连 > socks > http > nat64 > ip备用出口 > finallyProxyHost
/**- **警告**: snippets只支持最大两次connect，所以snippets全局nat64不能使用域名访问，snippets访问cf失败的备用只有第一个有效*/
const proxyStrategyOrder = ['socks', 'http', 'nat64'];
const dohEndpoints = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'];
const dohNatEndpoints = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
const dohFetchOptions = {method: 'POST', headers: {'content-type': 'application/dns-message'}};
const workerDnsEarlyDataFastPath = true;
const proxyIpAddrs = {EU: 'ProxyIP.DE.CMLiussss.net', AS: 'ProxyIP.SG.CMLiussss.net', JP: 'ProxyIP.JP.CMLiussss.net', US: 'ProxyIP.US.CMLiussss.net'};//分区域备用出口
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
const [textEncoder, textDecoder, socks5Init, httpHeaderEnd] = [new TextEncoder(), new TextDecoder(), new Uint8Array([5, 2, 0, 2]), new Uint8Array([13, 10, 13, 10])];
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
const parseAuthString = (authParam) => {
    let username, password, hostStr;
    const atIndex = authParam.lastIndexOf('@');
    if (atIndex === -1) {hostStr = authParam} else {
        const cred = authParam.substring(0, atIndex);
        hostStr = authParam.substring(atIndex + 1);
        const colonIndex = cred.indexOf(':');
        if (colonIndex === -1) {username = cred} else {
            username = cred.substring(0, colonIndex);
            password = cred.substring(colonIndex + 1);
        }
    }
    const [hostname, port] = parseHostPort(hostStr, 1080);
    return {username, password, hostname, port};
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
const createConnect = (hostname, port, socket = connect({hostname, port})) => socket.opened.then(() => socket);
const concurrentConnect = (hostname, port, addrType) => {
    if (concurrency === 1 || (concurrentOnlyDomain && addrType !== 3)) return createConnect(hostname, port);
    return Promise.any(Array(concurrency).fill(null).map(() => createConnect(hostname, port)));
};
const connectViaSocksProxy = async (targetAddrType, targetPortNum, socksAuth, targetAddrBytes) => {
    const addrType = isDomainName(socksAuth.hostname) ? 3 : 0;
    const socksSocket = await concurrentConnect(socksAuth.hostname, socksAuth.port, addrType);
    const writer = socksSocket.writable.getWriter();
    const reader = socksSocket.readable.getReader();
    let connected = false;
    try {
        await writer.write(socks5Init);
        const {value: authResponse} = await reader.read();
        if (!authResponse || authResponse[0] !== 5 || authResponse[1] === 0xFF) return null;
        if (authResponse[1] === 2) {
            if (!socksAuth.username) return null;
            const userBytes = textEncoder.encode(socksAuth.username);
            const passBytes = textEncoder.encode(socksAuth.password || '');
            await writer.write(new Uint8Array([1, userBytes.length, ...userBytes, passBytes.length, ...passBytes]));
            const {value: authResult} = await reader.read();
            if (!authResult || authResult[0] !== 1 || authResult[1] !== 0) return null;
        } else if (authResponse[1] !== 0) {return null}
        await writer.write(new Uint8Array([
            5, 1, 0, targetAddrType,
            ...(targetAddrType === 3 ? [targetAddrBytes.length] : []),
            ...targetAddrBytes, targetPortNum >> 8, targetPortNum & 0xff]));
        const {value: finalResponse} = await reader.read();
        if (!finalResponse || finalResponse[1] !== 0) return null;
        connected = true;
        return socksSocket;
    } catch {return null}
    finally {
        try {writer.releaseLock()} catch {}
        try {reader.releaseLock()} catch {}
        if (!connected) closeSocketQuietly(socksSocket);
    }
};
const staticHeadersPart = `User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36\r\nProxy-Connection: Keep-Alive\r\nConnection: Keep-Alive\r\n\r\n`;
const encodedStaticHeaders = textEncoder.encode(staticHeadersPart);
const connectViaHttpProxy = async (targetAddrType, targetPortNum, httpAuth, targetAddrBytes) => {
    const {username, password, hostname, port} = httpAuth;
    const addrType = isDomainName(hostname) ? 3 : 0;
    const proxySocket = await concurrentConnect(hostname, port, addrType);
    const writer = proxySocket.writable.getWriter();
    const httpHost = binaryAddrToString(targetAddrType, targetAddrBytes);
    let dynamicHeaders = `CONNECT ${httpHost}:${targetPortNum} HTTP/1.1\r\nHost: ${httpHost}:${targetPortNum}\r\n`;
    if (username) dynamicHeaders += `Proxy-Authorization: Basic ${btoa(`${username}:${password || ''}`)}\r\n`;
    const encodedDynamicHeaders = textEncoder.encode(dynamicHeaders);
    const fullHeaders = new Uint8Array(encodedDynamicHeaders.length + encodedStaticHeaders.length);
    fullHeaders.set(encodedDynamicHeaders);
    fullHeaders.set(encodedStaticHeaders, encodedDynamicHeaders.length);
    const reader = proxySocket.readable.getReader();
    const buffer = new Uint8Array(256);
    let bytesRead = 0, statusChecked = false;
    let connected = false;
    try {
        await writer.write(fullHeaders);
        while (bytesRead < buffer.length) {
            const {value, done} = await reader.read();
            if (done || bytesRead + value.length > buffer.length) return null;
            const prevBytesRead = bytesRead;
            buffer.set(value, bytesRead);
            bytesRead += value.length;
            if (!statusChecked && bytesRead >= 12) {
                if (buffer[9] !== 50) return null;
                statusChecked = true;
            }
            const searchStart = Math.max(15, prevBytesRead - 3);
            for (let i = searchStart; i <= bytesRead - 4; i++) {
                let found = true;
                for (let j = 0; j < 4; j++) {
                    if (buffer[i + j] !== httpHeaderEnd[j]) {
                        found = false;
                        break;
                    }
                }
                if (found) {
                    if (bytesRead > i + 4) {
                        const {readable, writable} = new TransformStream();
                        const writer = writable.getWriter();
                        writer.write(buffer.subarray(i + 4, bytesRead));
                        writer.releaseLock();
                        proxySocket.readable.pipeTo(writable).catch(() => {});
                        // @ts-ignore
                        proxySocket.readable = readable;
                    }
                    connected = true;
                    return proxySocket;
                }
            }
        }
        return null;
    } catch {return null}
    finally {
        try {writer.releaseLock()} catch {}
        try {reader.releaseLock()} catch {}
        if (!connected) closeSocketQuietly(proxySocket);
    }
};
const parseAddress = (buffer, offset, addrType) => {
    const addressLength = addrType === 3 ? buffer[offset++] : addrType === 1 ? 4 : addrType === 4 ? 16 : null;
    if (addressLength === null) return null;
    const newOffset = offset + addressLength;
    if (newOffset > buffer.length) return null;
    const targetAddrBytes = buffer.subarray(offset, newOffset);
    return {targetAddrBytes, dataOffset: newOffset};
};
const parseRequestData = (firstChunk) => {
    if (firstChunk.length < 24) return null;
    for (let i = 0; i < 16; i++) if (firstChunk[i + 1] !== uuidBytes[i]) return null;
    let offset = 19 + firstChunk[17];
    if (offset + 3 > firstChunk.length) return null;
    const port = (firstChunk[offset] << 8) | firstChunk[offset + 1];
    let addrType = firstChunk[offset + 2];
    if (addrType !== 1) addrType += 1;
    const addressInfo = parseAddress(firstChunk, offset + 3, addrType);
    if (!addressInfo) return null;
    return {addrType, ...addressInfo, port, isDns: port === 53};
};
const ipv4ToNat64Ipv6 = (ipv4Address, nat64Prefixes) => {
    const parts = ipv4Address.split('.');
    const hex = parts.map(part => {
        const num = parseInt(part, 10);
        return num.toString(16).padStart(2, '0');
    });
    return `[${nat64Prefixes}${hex[0]}${hex[1]}:${hex[2]}${hex[3]}]`;
};
const concurrentDnsResolve = async (hostname, recordType) => {
    try {
        const dnsResult = await Promise.any(dohNatEndpoints.map(endpoint =>
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
const connectNat64 = async (addrType, port, nat64Auth, targetAddrBytes, proxyAll) => {
    const nat64Prefixes = nat64Auth.startsWith('[') ? nat64Auth.slice(1, -1) : nat64Auth;
    if (!proxyAll) return await concurrentConnect(ipv4ToNat64Ipv6('104.19.65.36', nat64Prefixes), port, 4);
    if (addrType === 4) return null;
    const hostname = binaryAddrToString(addrType, targetAddrBytes);
    if (addrType === 1) return await concurrentConnect(ipv4ToNat64Ipv6(hostname, nat64Prefixes), port, 4);
    if (addrType === 3) {
        const answer = await concurrentDnsResolve(hostname, 'A');
        if (!answer) return null;
        const aRecord = answer.find(record => record.type === 1);
        if (aRecord && aRecord.data) return await concurrentConnect(ipv4ToNat64Ipv6(aRecord.data, nat64Prefixes), port, 4);
    }
    return null;
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
        const connectionPromises = resolvedIps.map(ip => {
            const [host, port] = parseHostPort(ip, 443);
            return createConnect(host, port);
        });
        try {return await Promise.any(connectionPromises)} catch {return null}
    }
    const [host, port] = parseHostPort(param, 443);
    const addrType = isDomainName(host) ? 3 : 0;
    return concurrentConnect(host, port, addrType);
}
const connectionParamAliases = {
    gs5: 'gs5', s5all: 'gs5',
    ghttp: 'ghttp', httpall: 'ghttp',
    gnat64: 'gnat64', nat64all: 'gnat64',
    s5: 's5', socks: 's5',
    http: 'http',
    ip: 'ip',
    nat64: 'nat64'
};
const parseConnectionParamSegment = (segment, params) => {
    const lowerSegment = segment.toLowerCase();
    if (lowerSegment === 'proxyall' || lowerSegment === 'globalproxy' || lowerSegment.startsWith('proxyall=') || lowerSegment.startsWith('globalproxy=')) {
        params.proxyAll = true;
        return;
    }
    let separatorIndex = segment.indexOf('='), separatorLength = 1;
    if (separatorIndex === -1) {
        separatorIndex = lowerSegment.indexOf('://');
        separatorLength = 3;
    }
    if (separatorIndex === -1) {
        separatorIndex = lowerSegment.indexOf('%3a%2f%2f');
        separatorLength = 9;
    }
    if (separatorIndex === -1) return;
    const normalizedKey = connectionParamAliases[lowerSegment.substring(0, separatorIndex)];
    if (!normalizedKey) return;
    let value = segment.substring(separatorIndex + separatorLength);
    if (value.endsWith('=')) value = value.slice(0, -1);
    params[normalizedKey] = value;
};
const parseConnectionParams = (requestUrl) => {
    const pathStart = requestUrl.indexOf('/', 10);
    if (pathStart === -1) return {proxyAll: false};
    let rawParams = requestUrl.substring(pathStart + 1);
    const queryIndex = rawParams.indexOf('?');
    if (queryIndex !== -1) rawParams = rawParams.substring(queryIndex + 1);
    if (rawParams.endsWith('/')) rawParams = rawParams.slice(0, -1);
    if (!rawParams) return {proxyAll: false};
    const params = {proxyAll: false};
    let segmentStart = rawParams.charCodeAt(0) === 63 ? 1 : 0;
    for (let i = segmentStart; i <= rawParams.length; i++) {
        if (i !== rawParams.length && rawParams.charCodeAt(i) !== 38) continue;
        if (i > segmentStart) parseConnectionParamSegment(rawParams.substring(segmentStart, i), params);
        segmentStart = i + 1;
    }
    return params;
};
const strategyExecutorMap = new Map([
    [0, async ({addrType, port, targetAddrBytes}) => {
        const hostname = binaryAddrToString(addrType, targetAddrBytes);
        return concurrentConnect(hostname, port, addrType);
    }],
    [1, async ({addrType, port, targetAddrBytes}, param) => {
        const socksAuth = parseAuthString(param);
        return connectViaSocksProxy(addrType, port, socksAuth, targetAddrBytes);
    }],
    [2, async ({addrType, port, targetAddrBytes}, param) => {
        const httpAuth = parseAuthString(param);
        return connectViaHttpProxy(addrType, port, httpAuth, targetAddrBytes);
    }],
    [3, async (_parsedRequest, param) => {
        return connectProxyIp(param);
    }],
    [4, async (_parsedRequest, _param) => {
        return concurrentConnect(finallyProxyHost, 443, 3);
    }],
    [5, async ({addrType, port, targetAddrBytes}, param) => {
        const {nat64Auth, proxyAll} = param;
        return connectNat64(addrType, port, nat64Auth, targetAddrBytes, proxyAll);
    }]
]);
const executeStrategy = async (parsedRequest, type, param) => {
    const executor = strategyExecutorMap.get(type);
    if (!executor) return null;
    try {return await executor(parsedRequest, param)} catch {return null}
};
const executeDecodedParamStrategies = async (parsedRequest, type, rawParam, transformParam = value => value) => {
    if (!rawParam) return null;
    const decodedParam = decodeURIComponent(rawParam);
    let itemStart = 0;
    for (let i = 0; i <= decodedParam.length; i++) {
        if (i !== decodedParam.length && decodedParam.charCodeAt(i) !== 44) continue;
        const value = decodedParam.substring(itemStart, i).trim();
        itemStart = i + 1;
        if (!value) continue;
        const tcpSocket = await executeStrategy(parsedRequest, type, transformParam(value));
        if (tcpSocket) return tcpSocket;
    }
    return null;
};
const establishTcpConnection = async (parsedRequest, request) => {
    const params = parseConnectionParams(request.url);
    const socksParam = params.gs5 ?? params.s5;
    const httpParam = params.ghttp ?? params.http;
    const nat64Param = params.gnat64 ?? params.nat64;
    const proxyAll = !!(params.proxyAll || params.gs5 || params.ghttp || params.gnat64);
    if (!proxyAll) {
        const directSocket = await executeStrategy(parsedRequest, 0);
        if (directSocket) return directSocket;
    }
    let hasProxyStrategy = false;
    for (const strategyKey of proxyStrategyOrder) {
        if (strategyKey === 'socks' && socksParam) {
            hasProxyStrategy = true;
            const tcpSocket = await executeDecodedParamStrategies(parsedRequest, 1, socksParam);
            if (tcpSocket) return tcpSocket;
        } else if (strategyKey === 'http' && httpParam) {
            hasProxyStrategy = true;
            const tcpSocket = await executeDecodedParamStrategies(parsedRequest, 2, httpParam);
            if (tcpSocket) return tcpSocket;
        } else if (strategyKey === 'nat64' && nat64Param) {
            hasProxyStrategy = true;
            const tcpSocket = await executeDecodedParamStrategies(parsedRequest, 5, nat64Param, nat64Auth => ({nat64Auth, proxyAll}));
            if (tcpSocket) return tcpSocket;
        }
    }
    if (proxyAll) return hasProxyStrategy ? null : executeStrategy(parsedRequest, 0);
    const proxyIpSocket = await executeDecodedParamStrategies(parsedRequest, 3, params.ip);
    if (proxyIpSocket) return proxyIpSocket;
    const regionalProxySocket = await executeStrategy(parsedRequest, 3, coloToProxyMap.get(request.cf?.colo) ?? proxyIpAddrs.US);
    if (regionalProxySocket) return regionalProxySocket;
    return executeStrategy(parsedRequest, 4);
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
const safeBufferSize = bufferSize - 4096;
const getWebSocketEarlyData = (request) => {
    const protocolHeader = request.headers.get('sec-websocket-protocol');
    if (!protocolHeader) return null;
    try {
        // @ts-ignore
        return Uint8Array.fromBase64(protocolHeader, {alphabet: 'base64url'});
    } catch {return null}
};
const normalizeWsChunk = (chunk) => chunk instanceof Uint8Array ? chunk : typeof chunk === 'string' ? textEncoder.encode(chunk) : new Uint8Array(chunk);
const streamPipe = (initialChunk) => {
    let buffer = new Uint8Array(bufferSize), offset = 0, timerId = null, resume = null;
    const flushBuffer = (controller) => {
        offset > 0 && (controller.enqueue(buffer.subarray(0, offset)), buffer = new Uint8Array(bufferSize), offset = 0);
        timerId && (clearTimeout(timerId), timerId = null), resume?.(), resume = null;
    };
    return new TransformStream({
        start(controller) {initialChunk?.byteLength > 0 && controller.enqueue(initialChunk)},
        transform(chunk, controller) {
            if (chunk.length < 4096) {
                flushBuffer(controller);
                controller.enqueue(chunk);
            } else {
                if (chunk.length > safeBufferSize) {
                    flushBuffer(controller);
                    controller.enqueue(chunk);
                    return;
                }
                if (offset + chunk.length > buffer.length) flushBuffer(controller);
                buffer.set(chunk, offset);
                offset += chunk.length;
                timerId || (timerId = setTimeout(() => flushBuffer(controller), flushTime));
                if (offset > safeBufferSize) return new Promise(resolve => resume = resolve);
            }
        },
        flush(controller) {flushBuffer(controller)}
    });
};
const manualPipe = async (readable, writable, initialChunk, userCache) => {
    if (initialChunk?.byteLength > 0) writable.send(initialChunk);
    if (!userCache) {
        for await (const chunk of readable) writable.send(chunk);
        return;
    }
    let buffer = new Uint8Array(bufferSize), offset = 0, timerId = null, resume = null;
    const flushBuffer = () => {
        offset > 0 && (writable.send(buffer.subarray(0, offset)), buffer = new Uint8Array(bufferSize), offset = 0);
        timerId && (clearTimeout(timerId), timerId = null), resume?.(), resume = null;
    };
    const reader = readable.getReader();
    try {
        while (true) {
            const {done, value: chunk} = await reader.read();
            if (done) break;
            if (chunk.length < 4096) {
                flushBuffer();
                writable.send(chunk);
            } else {
                if (chunk.length > safeBufferSize) {
                    flushBuffer();
                    writable.send(chunk);
                    continue;
                }
                if (offset + chunk.length > buffer.length) flushBuffer();
                buffer.set(chunk, offset);
                offset += chunk.length;
                timerId || (timerId = setTimeout(flushBuffer, flushTime));
                if (offset > safeBufferSize) await new Promise(resolve => resume = resolve);
            }
        }
    } finally {flushBuffer(), reader.releaseLock()}
};
const handleWebSocketConn = async (webSocket, request, earlyData = getWebSocketEarlyData(request)) => {
    let streamClosed = false;
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
            let parsedRequest;
            if ((parsedRequest = parseRequestData(chunk))) {
                webSocket.send(new Uint8Array([chunk[0], 0]));
            }
            if (!parsedRequest) throw new Error();
            const payload = chunk.subarray(parsedRequest.dataOffset);
            if (parsedRequest.isDns) {
                webSocket.send(await dohDnsHandler(payload));
                webSocket.close();
            } else {
                tcpSocket = await establishTcpConnection(parsedRequest, request);
                if (!tcpSocket) throw new Error();
                tcpWriter = tcpSocket.writable.getWriter();
                if (payload.byteLength) await tcpWriter.write(payload);
                messageHandler = tcpWriter.write.bind(tcpWriter);
                if (wsDownloadUserPipe) {
                    const streamChain = wsUserBufferer ? tcpSocket.readable.pipeThrough(streamPipe()) : tcpSocket.readable;
                    streamChain.pipeTo(new WritableStream({write(chunk) {webSocket.send(chunk)}})).catch(() => closeSocket()).finally(() => closeSocket());
                } else {
                    manualPipe(tcpSocket.readable, webSocket, null, wsUserBufferer).catch(() => closeSocket()).finally(() => closeSocket());
                }
            }
        }
    })).catch(() => closeSocket()).finally(() => closeSocket());
};
const isWebSocketUpgrade = (request) => request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
const shouldHandleDnsInWorker = (request, env, earlyData = getWebSocketEarlyData(request)) => {
    if (!workerDnsEarlyDataFastPath || !env?.HEAVY_DO || !isWebSocketUpgrade(request) || !earlyData?.byteLength) return false;
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
const shouldOffloadToHeavyDo = (request, env) => !!env?.HEAVY_DO && isWebSocketUpgrade(request);
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
        const earlyData = isWebSocketUpgrade(request) ? getWebSocketEarlyData(request) : null;
        if (shouldHandleDnsInWorker(request, env, earlyData)) return handleRequest(request, earlyData);
        if (shouldOffloadToHeavyDo(request, env)) return routeToHeavyDo(request, env);
        return handleRequest(request, earlyData);
    }
};
