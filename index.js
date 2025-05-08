import express from "express"
import { URL, URLSearchParams } from 'url'
import { Readable } from 'stream'
import crypto from 'crypto'
const router = express.Router()

const monobar_endpoint = process.env.MONOBAR_BACKEND
const monobar_token = process.env.MONOBAR_TOKEN
const monobar_user = process.env.MONOBAR_USER

const playSessionCache = new Map();

function generateGenSessionId() {
    return crypto.randomBytes(16).toString('hex');
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function stopEmbyTranscodeWithDelay(deviceId, playSessionId) {
    await delay(10000);
    if (!deviceId || !playSessionId) return;
    const url = `${monobar_endpoint}/Videos/ActiveEncodings?DeviceId=${deviceId}&PlaySessionId=${playSessionId}`;
    try {
        const response = await fetch(url, {
            method: 'DELETE',
            headers: {
                'X-Emby-Token': monobar_token,
            },
        });
        await response.text();
    } catch (e) {}
}

async function fetchLibraryItems({ parentId, host, sortBy, sortOrder, limit, itemType }) {
    let url;
    if (itemType === 'series') {
        url = `${monobar_endpoint}/Users/${monobar_user}/Items?ParentId=${parentId}` +
            `&IncludeItemTypes=Series` +
            `&Fields=BasicSyncInfo,CanDelete,CanDownload,PrimaryImageAspectRatio,ProductionYear,Status,EndDate` +
            `&StartIndex=0` +
            (sortBy ? `&SortBy=${encodeURIComponent(sortBy)}` : '') +
            (sortOrder ? `&SortOrder=${encodeURIComponent(sortOrder)}` : '') +
            `&EnableImageTypes=Primary,Backdrop,Thumb&ImageTypeLimit=1&Recursive=true` +
            (limit ? `&Limit=${encodeURIComponent(limit)}` : '');
    } else if (itemType === 'latest-tv') {
        url = `${monobar_endpoint}/Users/${monobar_user}/Items/Latest?ParentId=${parentId}` +
            `&Fields=BasicSyncInfo,ProductionYear,Overview,Status,EndDate` +
            `&IncludeImageTypes=Primary,Backdrop,Thumb` +
            (sortBy ? `&SortBy=${encodeURIComponent(sortBy)}` : '') +
            (sortOrder ? `&SortOrder=${encodeURIComponent(sortOrder)}` : '') +
            (limit ? `&Limit=${encodeURIComponent(limit)}` : '');
    } else {
        url = `${monobar_endpoint}/Users/${monobar_user}/Items?ParentId=${parentId}` +
            `&Fields=BasicSyncInfo,ProductionYear,Overview` +
            `&StartIndex=0&Recursive=true&Filters=IsNotFolder&IncludeImageTypes=Logo` +
            (sortBy ? `&SortBy=${encodeURIComponent(sortBy)}` : '') +
            (sortOrder ? `&SortOrder=${encodeURIComponent(sortOrder)}` : '') +
            (limit ? `&Limit=${encodeURIComponent(limit)}` : '');
    }
    try {
        const library = await fetch(url, {
            headers: {
                'Content-Type': 'application/json',
                'X-Emby-Token': monobar_token,
            },
        });
        if (!library.ok) {
            return { error: { message: 'Error fetching library', status: library.status, statusText: library.statusText }, items: [] };
        }
        const data = await library.json();
        let items = data.Items || (Array.isArray(data) ? data : []);
        if (items && Array.isArray(items)) {
            items.forEach(item => {
                let tag = null;
                let thumbType = null;
                if (item.ImageTags) {
                    if (item.ImageTags.Thumb) {
                        tag = item.ImageTags.Thumb;
                        thumbType = 'thumb';
                    } else if (item.ImageTags.Backdrop) {
                        tag = item.ImageTags.Backdrop;
                        thumbType = 'Backdrop';
                    } else if (item.ImageTags.Primary) {
                        tag = item.ImageTags.Primary;
                        thumbType = 'Primary';
                    }
                }
                item.thumbPath = (tag && thumbType && item.Id)
                    ? `${host}/monobar/image?type=${thumbType}&id=${item.Id}&tag=${tag}`
                    : '';
                const posterTag = (item.ImageTags && item.ImageTags.Primary) ? item.ImageTags.Primary : '';
                item.posterPath = (posterTag && item.Id)
                    ? `${host}/monobar/image?type=Primary&id=${item.Id}&tag=${posterTag}`
                    : '';
            });
        }
        return { items, error: null };
    } catch (e) {
        return { error: { message: e.message }, items: [] };
    }
}

async function extractBandwidthFromMasterPlaylist(data) {
    if (!data?.MediaSources[0]?.TranscodingUrl) return null;
    const url = new URL(data.MediaSources[0].TranscodingUrl, monobar_endpoint);
    const urlPath = url.pathname.replace(/\/[^/]+$/, '/master.m3u8');
    const masterUrl = `${monobar_endpoint}${urlPath}?${url.searchParams.toString()}`;
    try {
        const response = await fetch(masterUrl, {
            headers: { 'X-Emby-Token': monobar_token }
        });
        if (!response.ok) {
            return null
        };
        
        const content = await response.text();
        const lines = content.split('\n');
        for (const line of lines) {
            if (line.includes('BANDWIDTH=')) {
                const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
                if (bandwidthMatch) return parseInt(bandwidthMatch[1]);
            }
        }
    } catch (e) {}
    return null;
}

async function stopEmbyTranscode(deviceId, playSessionId) {
    if (!deviceId || !playSessionId) return;
    const url = `${monobar_endpoint}/Videos/ActiveEncodings?DeviceId=${deviceId}&PlaySessionId=${playSessionId}`;
    try {
        const response = await fetch(url, {
            method: 'DELETE',
            headers: {
                'X-Emby-Token': monobar_token,
            },
        });
        await response.text();
    } catch (e) {}
}

async function getEmbyPlaySessionId({ id, maxWidth, maxHeight, maxBitrate, genSessionId, audioStreamIndex }) {
    const playbackInfoRes = await fetch(`${monobar_endpoint}/Items/${id}/PlaybackInfo?UserId=${monobar_user}&StartTimeTicks=0&IsPlayback=true&AutoOpenLiveStream=true&reqformat=json`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Emby-Token': monobar_token,
        },
        body: JSON.stringify({
            "DeviceProfile": {
                "MaxStaticBitrate": maxBitrate,
                "MaxStreamingBitrate": maxBitrate,
                "TranscodingProfiles": [
                    {
                        "Container": "ts",
                        "Type": "Video",
                        "AudioCodec": "aac",
                        "VideoCodec": "h264",
                        "Context": "Streaming",
                        "Protocol": "hls",
                        "MaxAudioChannels": "6",
                        "MinSegments": "1",
                        "BreakOnNonKeyFrames": true,
                    }
                ],
                "CodecProfiles": [
                    {
                        "Type": "Video",
                        "Codec": "h264",
                        "Conditions": [
                            { "Condition": "LessThanEqual", "Property": "Width", "Value": String(maxWidth) },
                            { "Condition": "LessThanEqual", "Property": "Height", "Value": String(maxHeight) }
                        ]
                    }
                ]
            },
            "PlaySessionId": genSessionId,
            ...(audioStreamIndex !== undefined ? { "AudioStreamIndex": audioStreamIndex } : {})
        })
    });
    if (!playbackInfoRes.ok) return null;
    const playbackInfo = await playbackInfoRes.json();
    return playbackInfo && playbackInfo.MediaSources && playbackInfo.MediaSources[0] && playbackInfo.MediaSources[0].PlaySessionId;
}

setInterval(async () => {
    const now = Date.now();
    for (const [key, session] of playSessionCache.entries()) {
        if (now - session.lastAccessed > 60000) {
            if (session.embySessionIds && session.deviceId) {
                for (const embyId of Object.values(session.embySessionIds)) {
                    await stopEmbyTranscode(session.deviceId, embyId);
                }
            }
            playSessionCache.delete(key);
        }
    }
}, 10000);

router.use((req, res, next) => {
    if (req.headers['x-environment'] === 'development') {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});

router.get('/ping', async (req, res) => {
    if (!req.headers['x-real-ip']) {
        return res.status(400).send("Missing x-real-ip header");
    } else {
        res.status(200).send("pong");
    }
});

router.post('/ping', async (req, res) => {
    const response = {
        callingFrom: req.headers.origin,
        viaNginxProxy: req.headers['x-nginx-proxy'] || null,
    };
    res.send(response);
});

router.get('/', async (req, res) => {
    const host = req.headers['x-environment'] === 'development' ? 'http://10.10.10.10:328' : `https://api.darelisme.my.id`;
    const sortBy = req.query.sortBy || 'DateCreated&SortName';
    const sortOrder = req.query.sortOrder || 'Descending';
    const limit = 10;
    try {
        const home = await fetch(`${monobar_endpoint}/Users/${monobar_user}/Views?fields=ItemTypes`, {
            headers: {
                'Content-Type': 'application/json',
                'X-Emby-Token': monobar_token,
            },
        });
        if (!home.ok) {
            return res.status(home.status).send({ message: 'Error fetching home', error: home.statusText });
        }
        const data = await home.json();
        const result = [];
        for (const libraryItem of data.Items) {
            if(libraryItem.CollectionType == 'movies') {
                try {
                    const { items, error } = await fetchLibraryItems({ parentId: libraryItem.Id, host, sortBy, sortOrder, limit });
                    if (error) {
                        result.push({ name: libraryItem.Name, Id: libraryItem.Id, latest: [], error: error.statusText || error.message });
                        continue;
                    }
                    result.push({ ...libraryItem, latest: items });
                } catch (e) {
                    result.push({ name: libraryItem.Name, Id: libraryItem.Id, latest: [], error: e.message });
                }
            } else {
                try {
                    const { items, error } = await fetchLibraryItems({ parentId: libraryItem.Id, host, sortBy, sortOrder, limit, itemType: 'latest-tv' });
                    if (error) {
                        result.push({ name: libraryItem.Name, Id: libraryItem.Id, latest: [], error: error.statusText || error.message });
                        continue;
                    }
                    result.push({ ...libraryItem, latest: items });
                } catch (e) {
                    result.push({ name: libraryItem.Name, Id: libraryItem.Id, latest: [], error: e.message });
                }
            }
        }
        res.send(result);
    } catch (e) {
        res.status(500).send("Internal Server Error: " + e.message);
    }
});

router.get('/library', async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=720');
    const host = req.headers['x-environment'] === 'development' ? 'http://10.10.10.10:328' : `https://api.darelisme.my.id`;
    const id = req.query.id;
    const sortBy = req.query.sortBy;
    const sortOrder = req.query.sortOrder === 'asc' ? 'Ascending' : 'Descending';
    const itemType = req.query.itemType || null;
    if (!id) {
        return res.status(400).send("Missing 'id' query parameter");
    }
    try {
        let url = `${monobar_endpoint}/Items?Ids=${id}&IncludeItemTypes=CollectionFolder`;
        const itemInfo = await fetch(url, {
            headers: {
                'Content-Type': 'application/json',
                'X-Emby-Token': monobar_token,
            },
        });
        if (!itemInfo.ok) {
            return res.status(itemInfo.status).send({ message: 'Error fetching library', error: itemInfo.statusText });
        }
        const libraryInfoData = await itemInfo.json();
        const library = libraryInfoData.Items[0];
        let collectionType = library && library.CollectionType;
        let fetchType = itemType;
        if (!fetchType) {
            if (collectionType === 'tvshows' || collectionType === 'tvshowsseries' || collectionType === 'tv') {
                fetchType = 'series';
            } else {
                fetchType = null;
            }
        }
        const { items, error } = await fetchLibraryItems({ parentId: id, host, sortBy, sortOrder, itemType: fetchType });
        if (error) {
            return res.status(error.status || 500).send({ message: 'Error fetching library', error: error.statusText || error.message });
        }
        res.send({ library, content: items });
    } catch (e) {
        res.status(500).send("Internal Server Error: " + e.message);
    }
});

async function getItemInfo({ id, host }) {
    try {
        const info = await fetch(`${monobar_endpoint}/Users/${monobar_user}/Items/${id}/?fields=ShareLevel`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'X-Emby-Token': monobar_token,
            },
        });
        if (!info.ok) {
            throw new Error(`Error fetching item info: ${info.statusText}`);
        }
        const data = await info.json();
        if (data.BackdropImageTags && data.Id && Array.isArray(data.BackdropImageTags) && data.BackdropImageTags[0]) {
            data.BackdropImageTags = `${host}/monobar/image?type=Backdrop&id=${data.Id}&tag=${data.BackdropImageTags[0]}`;
        } else if (data.ImageTags.Primary) {
            data.BackdropImageTags = `${host}/monobar/image?type=Primary&id=${data.Id}&tag=${data.ImageTags.Primary}&maxWidth=1920&maxHeight=1080`;
        } else {
            data.BackdropImageTags = null;
        }
        if (data.ImageTags && data.Id) {
            const newImageTags = {};
            for (const [type, tag] of Object.entries(data.ImageTags)) {
                newImageTags[type] = `${host}/monobar/image?type=${type}&id=${data.Id}&tag=${tag}`;
            }
            data.ImageTags = newImageTags;
        }
        if (Array.isArray(data.People)) {
            data.People = data.People.map(person => ({
                ...person,
                image: person.PrimaryImageTag ? `${host}/monobar/image?type=Primary&id=${person.Id}&tag=${person.PrimaryImageTag}&quality=80&maxHeight=200` : null
            }));
        }
        const playUrl = `${host}/monobar/watch?intent=play&id=${id}`;
        return { ...data, playUrl };
    } catch (e) {
        throw e;
    }
}

async function getRecommendationInfo({ id, host }) {
    try {
        const info = await fetch(`${monobar_endpoint}/Items/${id}/Similar?limit=12&UserId=${monobar_user}&fields=ShareLevel&EnableTotalRecordCount=false`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'X-Emby-Token': monobar_token,
            },
        });
        if (!info.ok) {
            throw new Error(`Error fetching item info: ${info.statusText}`);
        }
        const data = await info.json();
        if (!data.Items || !Array.isArray(data.Items)) return [];
        return data.Items.map(item => {
            if (item.BackdropImageTags && item.Id && Array.isArray(item.BackdropImageTags) && item.BackdropImageTags[0]) {
                item.BackdropImageTags = `${host}/monobar/image?type=Backdrop&id=${item.Id}&tag=${item.BackdropImageTags[0]}`;
            } else if (item.ImageTags && item.ImageTags.Primary) {
                item.BackdropImageTags = `${host}/monobar/image?type=Primary&id=${item.Id}&tag=${item.ImageTags.Primary}&maxWidth=1920&maxHeight=1080`;
            } else {
                item.BackdropImageTags = null;
            }
            if (item.ImageTags && item.Id) {
                const newImageTags = {};
                for (const [type, tag] of Object.entries(item.ImageTags)) {
                    newImageTags[type] = `${host}/monobar/image?type=${type}&id=${item.Id}&tag=${tag}`;
                }
                item.ImageTags = newImageTags;
            }
            item.playUrl = `${host}/monobar/watch?intent=play&id=${item.Id}`;
            return item;
        });
    } catch (e) {
        throw e;
    }
}

async function getEmbyPlaybackInfo({ id, maxWidth, maxHeight, maxBitrate, label, genSessionId, audioStreamIndex }) {
    const playbackInfoRes = await fetch(`${monobar_endpoint}/Items/${id}/PlaybackInfo?UserId=${monobar_user}&StartTimeTicks=0&IsPlayback=true&AutoOpenLiveStream=true&reqformat=json`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Emby-Token': monobar_token,
        },
        body: JSON.stringify({
            "DeviceProfile": {
                "MaxStaticBitrate": maxBitrate,
                "MaxStreamingBitrate": maxBitrate,
                "TranscodingProfiles": [
                    {
                        "Container": "ts",
                        "Type": "Video",
                        "AudioCodec": "aac",
                        "VideoCodec": "h264",
                        "Context": "Streaming",
                        "Protocol": "hls",
                        "MaxAudioChannels": "6",
                        "MinSegments": "1",
                        "BreakOnNonKeyFrames": true,
                    }
                ],
                "CodecProfiles": [
                    {
                        "Type": "Video",
                        "Codec": "h264",
                        "Conditions": [
                            { "Condition": "LessThanEqual", "Property": "Width", "Value": String(maxWidth) },
                            { "Condition": "LessThanEqual", "Property": "Height", "Value": String(maxHeight) }
                        ]
                    }
                ]
            },
            "PlaySessionId": genSessionId,
            ...(audioStreamIndex !== undefined ? { "AudioStreamIndex": audioStreamIndex } : {})
        })
    });
    if (!playbackInfoRes.ok) return null;
    const playbackInfo = await playbackInfoRes.json();
    const actualBandwidth = await extractBandwidthFromMasterPlaylist(playbackInfo);
    if(!actualBandwidth) return null;
    if (!playbackInfo.MediaSources || !playbackInfo.MediaSources[0]) return null;
    const ms = playbackInfo.MediaSources && playbackInfo.MediaSources[0];
    if (!ms || !ms.TranscodingUrl) return null;
    return { 
        ms, 
        label, 
        maxWidth, 
        maxHeight, 
        maxBitrate, 
        playSessionId: playbackInfo.PlaySessionId, 
        actualBandwidth 
    };
}

router.get('/play', async (req, res) => {
    const id = req.query.id;
    const genSessionId = req.query.genSessionId;
    const q = req.query.q;
    let audioStreamIndex = req.query.audioStreamIndex !== undefined ? parseInt(req.query.audioStreamIndex) : undefined;
    const host = req.headers['x-environment'] === 'development' ? 'http://10.10.10.10:328' : `https://api.darelisme.my.id`;
    if (!id || !genSessionId || !q) return res.status(400).send("Missing 'id', 'genSessionId', or 'q' query parameter");
    const sessionKey = `${id}:${genSessionId}`;
    let session = playSessionCache.get(sessionKey);
    if (!session) {
        session = {
            genSessionId,
            embySessionIds: {},
            deviceId: undefined,
            lastAccessed: Date.now(),
            lastAudioStreamIndex: audioStreamIndex
        };
        playSessionCache.set(sessionKey, session);
    } else {
        session.lastAccessed = Date.now();
    }
    if (audioStreamIndex !== undefined) {
        session.lastAudioStreamIndex = audioStreamIndex;
    } else if (session.lastAudioStreamIndex !== undefined) {
        audioStreamIndex = session.lastAudioStreamIndex;
    }
    const allQualities = [
        { label: '360p', maxWidth: 640, maxHeight: 360, maxBitrate: 1000000 },
        { label: '480p', maxWidth: 854, maxHeight: 480, maxBitrate: 1750000 },
        { label: '720p', maxWidth: 1280, maxHeight: 720, maxBitrate: 3000000 },
    ];
    const quality = allQualities.find(x => x.label === q);
    if (!quality) return res.status(400).send("Invalid quality");
    const info = await getEmbyPlaybackInfo({ id, ...quality, genSessionId, audioStreamIndex });
    if (!info) return res.status(500).send("Failed to get playback info");
    if (!session.deviceId) {
        if (info.ms.DeviceId) {
            session.deviceId = info.ms.DeviceId;
        } else if (info.ms.TranscodingUrl) {
            const urlObj = new URL(info.ms.TranscodingUrl, 'http://dummy');
            const deviceIdFromUrl = urlObj.searchParams.get('DeviceId');
            if (deviceIdFromUrl) session.deviceId = deviceIdFromUrl;
        }
    }
    const embyKey = audioStreamIndex !== undefined ? `${q}:${audioStreamIndex}` : q;
    session.embySessionIds[embyKey] = info.ms.PlaySessionId || info.playSessionId;
    session.lastAudioStreamIndex = audioStreamIndex;
    const playlistUrl = `${host}/monobar/play/playlist?id=${id}&genSessionId=${genSessionId}&q=${q}`;
    res.redirect(playlistUrl);
});

router.get('/play/playlist', async (req, res) => {
    const host = req.headers['x-environment'] === 'development' ? 'http://10.10.10.10:328' : `https://api.darelisme.my.id`;
    let id = req.query.id;
    let genSessionId = req.query.genSessionId;
    let q = req.query.q;
    let audioStreamIndex = req.query.audioStreamIndex !== undefined ? parseInt(req.query.audioStreamIndex) : undefined;
    if ((!id || !genSessionId || !q) && req.query.label && req.query.PlaySessionId) {
        id = req.query.id;
        let foundSessionKey = null;
        let foundQ = null;
        for (const [key, session] of playSessionCache.entries()) {
            for (const [quality, embyId] of Object.entries(session.embySessionIds || {})) {
                if (embyId === req.query.PlaySessionId) {
                    foundSessionKey = key;
                    foundQ = quality;
                    break;
                }
            }
            if (foundSessionKey) break;
        }
        if (foundSessionKey) {
            const [foundId, foundGenSessionId] = foundSessionKey.split(":");
            id = foundId;
            genSessionId = foundGenSessionId;
            q = foundQ || req.query.label;
        }
    }
    if (!id || !genSessionId || !q) {
        return res.status(400).send("Missing 'id', 'genSessionId', or 'q' query parameter");
    }
    const sessionKey = `${id}:${genSessionId}`;
    let session = playSessionCache.get(sessionKey);
    if (!session) {
        session = {
            genSessionId,
            embySessionIds: {},
            deviceId: undefined,
            lastAccessed: Date.now(),
            lastAudioStreamIndex: audioStreamIndex
        };
        playSessionCache.set(sessionKey, session);
    } else {
        session.lastAccessed = Date.now();
        if (audioStreamIndex !== undefined) session.lastAudioStreamIndex = audioStreamIndex;
        else if (session.lastAudioStreamIndex !== undefined) audioStreamIndex = session.lastAudioStreamIndex;
    }
    const embyKey = audioStreamIndex !== undefined ? `${q}:${audioStreamIndex}` : q;
    let embySessionId = session.embySessionIds[embyKey];
    let deviceId = session.deviceId;
    if (!embySessionId || !deviceId) {
        const allQualities = [
            { label: '360p', maxWidth: 640, maxHeight: 360, maxBitrate: 1000000 },
            { label: '480p', maxWidth: 854, maxHeight: 480, maxBitrate: 1750000 },
            { label: '720p', maxWidth: 1280, maxHeight: 720, maxBitrate: 3000000 },
        ];
        const quality = allQualities.find(x => x.label === q);
        const info = await getEmbyPlaybackInfo({ id, ...quality, genSessionId, audioStreamIndex });
        if (!info) return res.status(500).send("Failed to get playback info");
        if (!session.deviceId) {
            if (info.ms.DeviceId) {
                session.deviceId = info.ms.DeviceId;
            } else if (info.ms.TranscodingUrl) {
                const urlObj = new URL(info.ms.TranscodingUrl, 'http://dummy');
                const deviceIdFromUrl = urlObj.searchParams.get('DeviceId');
                if (deviceIdFromUrl) session.deviceId = deviceIdFromUrl;
            }
        }
        session.embySessionIds[embyKey] = info.ms.PlaySessionId || info.playSessionId;
        session.lastAudioStreamIndex = audioStreamIndex;
        embySessionId = session.embySessionIds[embyKey];
        deviceId = session.deviceId;
    }
    const queryParams = new URLSearchParams();
    queryParams.set('DeviceId', deviceId);
    queryParams.set('PlaySessionId', embySessionId);
    queryParams.set('label', q);
    queryParams.set('api_key', monobar_token);
    if (audioStreamIndex !== undefined) queryParams.set('AudioStreamIndex', audioStreamIndex);
    const baseMonobarUrl = `${monobar_endpoint}/videos/${id}`;
    const originalM3u8Url = `${baseMonobarUrl}/main.m3u8?${queryParams.toString()}`;
    try {
        const watchPointResponse = await fetch(originalM3u8Url);
        if (!watchPointResponse.ok) {
            return res.status(watchPointResponse.status).send(`Error fetching M3U8: ${watchPointResponse.statusText}`);
        }
        const m3u8Content = await watchPointResponse.text();
        const lines = m3u8Content.split('\n');
        const modifiedLines = lines.map(line => {
            line = line.trim();
            if (line && !line.startsWith('#')) {
                let url = `${host}/monobar/play/segment/${line}?id=${id}&genSessionId=${genSessionId}&q=${q}`;
                if (audioStreamIndex !== undefined) url += `&audioStreamIndex=${audioStreamIndex}`;
                return url;
            }
            return line;
        });
        const modifiedM3u8Content = modifiedLines.join('\n');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(modifiedM3u8Content);
    } catch (e) {
        res.status(500).send("Internal Server Error: " + e.message);
    }
});

router.get('/play/segment/*', async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const segmentPath = req.params[0];
    let mergedQuery = { ...req.query };
    const urlParts = req.originalUrl.split('?');
    if (urlParts.length > 2) {
        for (let i = 2; i < urlParts.length; i++) {
            const extraParams = new URLSearchParams(urlParts[i]);
            for (const [key, value] of extraParams.entries()) {
                mergedQuery[key] = value;
            }
        }
    }
    let id = mergedQuery.id;
    let genSessionId = mergedQuery.genSessionId;
    let q = mergedQuery.q;
    let audioStreamIndex = mergedQuery.audioStreamIndex !== undefined ? parseInt(mergedQuery.audioStreamIndex) : undefined;
    if ((!id || !genSessionId || !q) && mergedQuery.PlaySessionId) {
        let foundSessionKey = null;
        let foundQ = null;
        for (const [key, session] of playSessionCache.entries()) {
            for (const [quality, embyId] of Object.entries(session.embySessionIds || {})) {
                if (embyId === mergedQuery.PlaySessionId) {
                    foundSessionKey = key;
                    foundQ = quality;
                    break;
                }
            }
            if (foundSessionKey) break;
        }
        if (foundSessionKey) {
            const [foundId, foundGenSessionId] = foundSessionKey.split(":");
            id = foundId;
            genSessionId = foundGenSessionId;
            q = foundQ;
        }
    }
    if (!id || !genSessionId || !q) {
        return res.status(400).send("Missing 'id', 'genSessionId', or 'q' query parameter");
    }
    const sessionKey = `${id}:${genSessionId}`;
    const session = playSessionCache.get(sessionKey);
    if (!session) {
        return res.status(404).send("Session not found");
    }
    const embyKey = audioStreamIndex !== undefined ? `${q}:${audioStreamIndex}` : q;
    const embySessionId = session.embySessionIds[embyKey];
    const deviceId = session.deviceId;
    if (!embySessionId || !deviceId) {
        return res.status(404).send("Emby session not found");
    }
    session.lastUsed = Date.now();
    session.lastAccessed = Date.now();
    const queryParams = new URLSearchParams();
    queryParams.set('DeviceId', deviceId);
    queryParams.set('PlaySessionId', embySessionId);
    queryParams.set('api_key', monobar_token);
    if (audioStreamIndex !== undefined) queryParams.set('AudioStreamIndex', audioStreamIndex);
    const originalSegmentUrl = `${monobar_endpoint}/videos/${id}/${segmentPath}?${queryParams.toString()}`;
    let segmentResponse;
    let retries = 5;
    let delayMs = 1000;
    for (let attempt = 0; attempt < retries; attempt++) {
        segmentResponse = await fetch(originalSegmentUrl);
        if (segmentResponse.ok) break;
        if (segmentResponse.status !== 404) break;
        if (attempt < retries - 1) await delay(delayMs);
    }
    if (!segmentResponse.ok) {
        return res.status(segmentResponse.status).send(`Error fetching segment: ${segmentResponse.statusText}`);
    }
    res.setHeader('Content-Type', segmentResponse.headers.get('Content-Type') || 'video/mp2t');
    const contentLength = segmentResponse.headers.get('Content-Length');
    if (contentLength) {
        res.setHeader('Content-Length', contentLength);
    }
    if (segmentResponse.body) {
        const nodeStream = Readable.fromWeb(segmentResponse.body);
        nodeStream.pipe(res);
        await new Promise((resolve, reject) => {
            nodeStream.on('end', resolve);
            nodeStream.on('error', reject);
            res.on('close', () => {
                nodeStream.destroy();
                resolve();
            });
            res.on('error', reject);
        });
    } else {
        res.end();
    }
});

router.get('/watch', async (req, res) => {
    const id = req.query.id;
    const host = req.headers['x-environment'] === 'development' ? 'http://10.10.10.10:328' : `https://api.darelisme.my.id`;
    const intent = req.query.intent;
    if (!id) {
        return res.status(400).send("Missing 'id' query parameter");
    }
    if (!intent) {
        return res.status(400).send("Missing 'intent' query parameter");
    }
    if (intent == 'info') {
        try {
            const [itemInfo, recommendation] = await Promise.all([
                getItemInfo({ id, host }),
                getRecommendationInfo({ id, host })
            ]);
            const result = {
                ...itemInfo,
                recommendation: recommendation || [],
            };
            res.send(result);
        } catch (e) {
            res.status(500).send("Internal Server Error: " + e.message);
        }
    } else if (intent == 'play') {
        try {
            const deviceId = req.query.DeviceId;
            const sessionKey = `${id}:${req.ip}`;
            let session = playSessionCache.get(sessionKey);
            if (!session) {
                session = {
                    genSessionId: generateGenSessionId(),
                    embySessionIds: {},
                    deviceId: deviceId || undefined,
                    lastAccessed: Date.now(),
                };
                playSessionCache.set(sessionKey, session);
            } else {
                session.lastAccessed = Date.now();
                if (deviceId) session.deviceId = deviceId;
            }
            const infoData = await getItemInfo({ id, host });
            let subtitlesArr = [];
            let chaptersArr = [];
            if (infoData.MediaSources && infoData.MediaSources.length > 0) {
                const mediaSourceId = infoData.MediaSources[0].Id;
                const chapters = infoData.MediaSources[0].Chapters || [];
                const durationTicks = infoData.MediaSources[0].RunTimeTicks || infoData.RunTimeTicks || null;
                for (let i = 0; i < chapters.length; i++) {
                    const chapter = chapters[i];
                    const nextChapter = chapters[i + 1];
                    const start = chapter.StartPositionTicks / 10000000;
                    let end;
                    if (nextChapter) {
                        end = nextChapter.StartPositionTicks / 10000000;
                    } else if (durationTicks) {
                        end = durationTicks / 10000000;
                    } else {
                        end = start + 10;
                    }
                    chaptersArr.push({
                        start,
                        end,
                        title: chapter.Name || `Chapter ${i + 1}`
                    });
                }
                for (let subitem of infoData.MediaSources[0].MediaStreams || []) {
                    if (subitem.IsTextSubtitleStream) {
                        const subtitleUrl = `${host}/monobar/watch/subtitle?subIndex=${subitem.Index}&itemId=${id}&mediaSourceId=${mediaSourceId}&format=vtt`;
                        if (subitem.Index === 0) {
                            subtitlesArr.push({
                                default: true,
                                url: subtitleUrl,
                                html: subitem.DisplayTitle,
                                name: subitem.DisplayTitle,
                                format: 'vtt',
                                index: subitem.Index
                            });
                        } else {
                            subtitlesArr.push({
                                url: subtitleUrl,
                                html: subitem.DisplayTitle,
                                name: subitem.DisplayTitle,
                                format: 'vtt',
                                index: subitem.Index
                            });
                        }
                    }
                }
            }
            const playbackUrl = `${host}/monobar/watch/master/playlist?id=${id}&genSessionId=${session.genSessionId}`;
            res.send({
                ...infoData,
                subtitles: subtitlesArr,
                Chapters: chaptersArr,
                playbackUrl
            });
        } catch (e) {
            res.status(500).send("Internal Server Error: " + e.message);
        }
    } else {
        return res.status(400).send("Invalid 'intent' parameter.");
    }
});

router.get('/watch/master/playlist', async (req, res) => {
    const id = req.query.id;
    const genSessionId = req.query.genSessionId;
    const host = req.headers['x-environment'] === 'development' ? 'http://10.10.10.10:328' : `https://api.darelisme.my.id`;
    const deviceId = req.query.DeviceId;
    if (!id || !genSessionId) return res.status(400).send("Missing 'id' or 'genSessionId' query parameter");
    const sessionKey = `${id}:${genSessionId}`;
    let session = playSessionCache.get(sessionKey);
    if (!session) {
        session = {
            genSessionId,
            embySessionIds: {},
            deviceId: deviceId || undefined,
            lastAccessed: Date.now(),
            lastAudioStreamIndex: undefined
        };
        playSessionCache.set(sessionKey, session);
    } else {
        session.lastAccessed = Date.now();
        if (deviceId) session.deviceId = deviceId;
    }
    try {
        const itemInfo = await getItemInfo({ id, host });
        const width = itemInfo.Width || (itemInfo.MediaStreams && itemInfo.MediaStreams.find(s => s.Type === 'Video')?.Width);
        const height = itemInfo.Height || (itemInfo.MediaStreams && itemInfo.MediaStreams.find(s => s.Type === 'Video')?.Height);
        const allQualities = [
            { label: '360p', maxWidth: 640, maxHeight: 360, maxBitrate: 1000000 },
            { label: '480p', maxWidth: 854, maxHeight: 480, maxBitrate: 1750000 },
            { label: '720p', maxWidth: 1280, maxHeight: 720, maxBitrate: 3000000 },
        ];
        let allowedQualities = [];
        for (const q of allQualities) {
            if (width >= q.maxWidth && height >= q.maxHeight) {
                allowedQualities.push(q);
            } else if (
                (width === q.maxWidth || height === q.maxHeight) ||
                (q === allQualities[allQualities.length - 1] && allowedQualities.length === 0)
            ) {
                allowedQualities.push(q);
                break;
            }
        }
        if (allowedQualities.length === 0) {
            allowedQualities.push(allQualities[0]);
        }
        const audioStreams = (itemInfo.MediaStreams || []).filter(s => s.Type === 'Audio');
        if (audioStreams.length > 0 && session.lastAudioStreamIndex === undefined) {
            session.lastAudioStreamIndex = audioStreams[0].Index;
        }
        let masterM3U8 = '#EXTM3U\n';
        if (audioStreams.length > 0) {
            for (const audio of audioStreams) {
                masterM3U8 += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"${audio.DisplayTitle || audio.Language || 'Audio ' + audio.Index}\",DEFAULT=${audio.Index === audioStreams[0].Index ? 'YES' : 'NO'},AUTOSELECT=${audio.Index === audioStreams[0].Index ? 'YES' : 'NO'},LANGUAGE=\"${audio.Language || ''}\",URI=\"${host}/monobar/play/playlist?id=${id}&genSessionId=${genSessionId}&q=720p&audioStreamIndex=${audio.Index}\"\n`;
            }
        }
        for (const q of allowedQualities) {
            masterM3U8 += `#EXT-X-STREAM-INF:BANDWIDTH=${q.maxBitrate},RESOLUTION=${q.maxWidth}x${q.maxHeight},NAME=\"${q.label}\",AUDIO=\"audio\"\n${host}/monobar/play/playlist?id=${id}&genSessionId=${genSessionId}&q=${q.label}\n`;
        }
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(masterM3U8);
    } catch (e) {
        res.status(500).send("Internal Server Error: " + e.message);
    }
});

router.get('/watch/main/playlist', async (req, res) => {
    const host = req.headers['x-environment'] === 'development' ? 'http://10.10.10.10:328' : `https://api.darelisme.my.id`;
    const deviceId = req.query.DeviceId;
    const mediaSourceId = req.query.MediaSourceId;
    const playSessionId = req.query.PlaySessionId;
    const apiKey = req.query.api_key;
    const videoCodec = req.query.VideoCodec;
    const audioCodec = req.query.AudioCodec;
    const videoBitrate = req.query.VideoBitrate;
    const audioBitrate = req.query.AudioBitrate;
    const maxWidth = req.query.MaxWidth;
    const audioStreamIndex = req.query.AudioStreamIndex;
    const subtitleStreamIndex = req.query.SubtitleStreamIndex;
    const subtitleMethod = req.query.SubtitleMethod;
    const transcodingMaxAudioChannels = req.query.TranscodingMaxAudioChannels;
    const segmentContainer = req.query.SegmentContainer;
    const minSegments = req.query.MinSegments;
    const breakOnNonKeyFrames = req.query.BreakOnNonKeyFrames;
    const subtitleStreamIndexes = req.query.SubtitleStreamIndexes;
    const manifestSubtitles = req.query.ManifestSubtitles;
    const h264Profile = req.query['h264-profile'];
    const h264Level = req.query['h264-level'];
    const transcodeReasons = req.query.TranscodeReasons;
    const id = req.query.id;
    const filename = req.query.filename || "main.m3u8";
    if (!id || !filename) {
        return res.status(400).send("Missing 'id' or 'filename' query parameter");
    }
    const queryParams = new URLSearchParams();
    if (deviceId !== undefined) queryParams.set('DeviceId', deviceId);
    if (mediaSourceId !== undefined) queryParams.set('MediaSourceId', mediaSourceId);
    if (playSessionId !== undefined) queryParams.set('PlaySessionId', playSessionId);
    if (apiKey !== undefined) queryParams.set('api_key', apiKey);
    if (videoCodec !== undefined) queryParams.set('VideoCodec', videoCodec);
    if (audioCodec !== undefined) queryParams.set('AudioCodec', audioCodec);
    if (videoBitrate !== undefined) queryParams.set('VideoBitrate', videoBitrate);
    if (audioBitrate !== undefined) queryParams.set('AudioBitrate', audioBitrate);
    if (maxWidth !== undefined) queryParams.set('MaxWidth', maxWidth);
    if (audioStreamIndex !== undefined) queryParams.set('AudioStreamIndex', audioStreamIndex);
    if (subtitleStreamIndex !== undefined) queryParams.set('SubtitleStreamIndex', subtitleStreamIndex);
    if (subtitleMethod !== undefined) queryParams.set('SubtitleMethod', subtitleMethod);
    if (transcodingMaxAudioChannels !== undefined) queryParams.set('TranscodingMaxAudioChannels', transcodingMaxAudioChannels);
    if (segmentContainer !== undefined) queryParams.set('SegmentContainer', segmentContainer);
    if (minSegments !== undefined) queryParams.set('MinSegments', minSegments);
    if (breakOnNonKeyFrames !== undefined) queryParams.set('BreakOnNonKeyFrames', breakOnNonKeyFrames);
    if (subtitleStreamIndexes !== undefined) queryParams.set('SubtitleStreamIndexes', subtitleStreamIndexes);
    if (manifestSubtitles !== undefined) queryParams.set('ManifestSubtitles', manifestSubtitles);
    if (h264Profile !== undefined) queryParams.set('h264-profile', h264Profile);
    if (h264Level !== undefined) queryParams.set('h264-level', h264Level);
    if (transcodeReasons !== undefined) queryParams.set('TranscodeReasons', transcodeReasons);
    const baseMonobarUrl = `${monobar_endpoint}/videos/${id}`;
    const originalM3u8Url = `${baseMonobarUrl}/${filename}?${queryParams.toString()}`;
    try {
        const watchPointResponse = await fetch(originalM3u8Url);
        if (!watchPointResponse.ok) {
            const errorBody = await watchPointResponse.text();
            return res.status(watchPointResponse.status).send(`Error fetching M3U8: ${watchPointResponse.statusText}`);
        }
        const m3u8Content = await watchPointResponse.text();
        const lines = m3u8Content.split('\n');
        const modifiedLines = lines.map(line => {
            line = line.trim();
            if (line && !line.startsWith('#')) {
                const [segmentPath, segmentQueryString] = line.split('?');
                const segmentParams = new URLSearchParams(segmentQueryString);
                const newSegmentParams = new URLSearchParams();
                if (deviceId !== undefined) newSegmentParams.set('DeviceId', deviceId);
                if (mediaSourceId !== undefined) newSegmentParams.set('MediaSourceId', mediaSourceId);
                if (playSessionId !== undefined) newSegmentParams.set('PlaySessionId', playSessionId);
                if (apiKey !== undefined) newSegmentParams.set('api_key', apiKey);
                if (videoCodec !== undefined) newSegmentParams.set('VideoCodec', videoCodec);
                if (audioCodec !== undefined) newSegmentParams.set('AudioCodec', audioCodec);
                if (videoBitrate !== undefined) newSegmentParams.set('VideoBitrate', videoBitrate);
                if (audioBitrate !== undefined) newSegmentParams.set('AudioBitrate', audioBitrate);
                if (maxWidth !== undefined) newSegmentParams.set('MaxWidth', maxWidth);
                if (audioStreamIndex !== undefined) newSegmentParams.set('AudioStreamIndex', audioStreamIndex);
                if (subtitleStreamIndex !== undefined) newSegmentParams.set('SubtitleStreamIndex', subtitleStreamIndex);
                if (subtitleMethod !== undefined) newSegmentParams.set('SubtitleMethod', subtitleMethod);
                if (transcodingMaxAudioChannels !== undefined) newSegmentParams.set('TranscodingMaxAudioChannels', transcodingMaxAudioChannels);
                if (segmentContainer !== undefined) newSegmentParams.set('SegmentContainer', segmentContainer);
                if (minSegments !== undefined) newSegmentParams.set('MinSegments', minSegments);
                if (breakOnNonKeyFrames !== undefined) newSegmentParams.set('BreakOnNonKeyFrames', breakOnNonKeyFrames);
                if (subtitleStreamIndexes !== undefined) newSegmentParams.set('SubtitleStreamIndexes', subtitleStreamIndexes);
                if (manifestSubtitles !== undefined) newSegmentParams.set('ManifestSubtitles', manifestSubtitles);
                if (h264Profile !== undefined) newSegmentParams.set('h264-profile', h264Profile);
                if (h264Level !== undefined) newSegmentParams.set('h264-level', h264Level);
                if (transcodeReasons !== undefined) newSegmentParams.set('TranscodeReasons', transcodeReasons);
                newSegmentParams.set('videoId', id);
                return `${host}/monobar/watch/main/segment/${segmentPath}?${newSegmentParams.toString()}`;
            }
            return line;
        });
        const modifiedM3u8Content = modifiedLines.join('\n');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(modifiedM3u8Content);
    } catch (e) {
        res.status(500).send("Internal Server Error: " + e.message);
    }
});

router.get('/watch/main/segment/*', async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const segmentPath = req.params[0];
    const videoId = req.query.videoId;
    if (!videoId) {
        return res.status(400).send("Missing 'videoId' query parameter");
    }
    if (!segmentPath) {
        return res.status(400).send("Missing segment path");
    }
    const originalQuery = new URLSearchParams(req.query);
    originalQuery.delete('videoId');
    const originalQueryString = originalQuery.toString();
    const originalSegmentUrl = `${monobar_endpoint}/videos/${videoId}/${segmentPath}${originalQueryString ? '?' + originalQueryString : ''}`;
    try {
        const segmentResponse = await fetch(originalSegmentUrl);
        if (!segmentResponse.ok) {
            const errorBody = await segmentResponse.text();
            return res.status(segmentResponse.status).send(`Error fetching segment: ${segmentResponse.statusText}`);
        }
        res.setHeader('Content-Type', segmentResponse.headers.get('Content-Type') || 'video/mp2t');
        const contentLength = segmentResponse.headers.get('Content-Length');
        if (contentLength) {
            res.setHeader('Content-Length', contentLength);
        }
        if (segmentResponse.body) {
            const nodeStream = Readable.fromWeb(segmentResponse.body);
            nodeStream.pipe(res);
            await new Promise((resolve, reject) => {
                nodeStream.on('end', resolve);
                nodeStream.on('error', reject);
                res.on('close', () => {
                    nodeStream.destroy();
                    resolve();
                });
                res.on('error', reject);
            });
        } else {
            res.end();
        }
    } catch (e) {
        if (!res.headersSent) {
            res.status(500).send("Internal Server Error");
        } else {
            res.end();
        }
    }
});

router.get('/watch/subtitle', async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const subIndex = req.query.subIndex;
    const itemId = req.query.itemId;
    const mediaSourceId = req.query.mediaSourceId;
    const format = req.query.format || "vtt";
    if (!subIndex || !itemId || !mediaSourceId || !format) {
        return res.status(400).send("Missing 'subIndex', 'itemId', 'mediaSourceId', or 'format' query parameter");
    }
    const subtitleUrl = `${monobar_endpoint}/Items/${itemId}/${mediaSourceId}/Subtitles/${subIndex}/Stream.${format}`;
    try {
        const subtitleResponse = await fetch(subtitleUrl, {
            headers: {
                'X-Emby-Token': monobar_token,
            },
        });
        if (!subtitleResponse.ok) {
            return res.status(subtitleResponse.status).send({ message: 'Error fetching subtitle', error: subtitleResponse.statusText });
        }
        const subtitleData = await subtitleResponse.text();
        res.setHeader('Content-Type', 'text/vtt');
        res.send(subtitleData);
    } catch (e) {
        res.status(500).send("Internal Server Error: " + e.message);
    }
});

router.post('/status', async (req, res) => {
    const intent = req.body.intent;
    const currentTime = req.body.currentTime;
    const seekableRange = req.body.seekableRange;
    const playSessionId = req.body.playSessionId;
    const currentSubtitleIndex = req.body.currentSubtitleIndex;
    const currentAudioIndex = req.body.currentAudioIndex;
    const mediaSourceId = req.body.mediaSourceId;
    const itemId = req.body.itemId;
    const playbackStartTimeTicks = req.body.playbackStartTimeTicks;
    const playlistIndex = req.body.playlistIndex || 0;
    const playlistLength = req.body.playlistLength || 1;
    const nowPlayingQueue = req.body.nowPlayingQueue;

    const toTicks = (seconds) => typeof seconds === 'number' ? Math.round(seconds * 10000000) : seconds;
    const positionTicks = toTicks(currentTime) || 0;
    let defaultSeekableRanges = [];
    if (seekableRange && typeof seekableRange === 'object' && seekableRange.start !== undefined && seekableRange.end !== undefined) {
        defaultSeekableRanges = [{
            start: toTicks(seekableRange.start),
            end: toTicks(seekableRange.end)
        }];
    }

    let playSessionIdToUse = playSessionId;
    if (intent === 'unpause') {
        const sessionKey = `${itemId}:${req.body.genSessionId || ''}`;
        const session = playSessionCache.get(sessionKey);
        let sessionNeedsRestart = false;
        if (!session || !session.embySessionIds || !Object.values(session.embySessionIds).includes(playSessionId)) {
            sessionNeedsRestart = true;
        }
        if (sessionNeedsRestart) {
            const quality = req.body.quality || '720p';
            const allQualities = [
                { label: '360p', maxWidth: 640, maxHeight: 360, maxBitrate: 1000000 },
                { label: '480p', maxWidth: 854, maxHeight: 480, maxBitrate: 1750000 },
                { label: '720p', maxWidth: 1280, maxHeight: 720, maxBitrate: 3000000 },
            ];
            const q = allQualities.find(x => x.label === quality) || allQualities[2];
            const newPlaySessionId = await getEmbyPlaySessionId({
                id: itemId,
                maxWidth: q.maxWidth,
                maxHeight: q.maxHeight,
                maxBitrate: q.maxBitrate,
                genSessionId: req.body.genSessionId,
                audioStreamIndex: currentAudioIndex
            });
            if (newPlaySessionId) {
                playSessionIdToUse = newPlaySessionId;
                if (session) {
                    session.embySessionIds[quality] = newPlaySessionId;
                } else {
                    playSessionCache.set(sessionKey, {
                        genSessionId: req.body.genSessionId,
                        embySessionIds: { [quality]: newPlaySessionId },
                        deviceId: undefined,
                        lastAccessed: Date.now(),
                        lastAudioStreamIndex: currentAudioIndex
                    });
                }
            }
        }
    }

    const baseBody = {
        IsMuted: false,
        PlaybackRate: 1,
        PlayMethod: "Transcode",
        PlaySessionId: playSessionIdToUse,
        MediaSourceId: mediaSourceId,
        CanSeek: true,
        ItemId: itemId,
    };
    let body = {};
    if (intent === 'play') {
        body = {
            ...baseBody,
            IsPaused: false,
            PositionTicks: positionTicks || 90000,
            PlaybackStartTimeTicks: playbackStartTimeTicks,
            SubtitleStreamIndex: currentSubtitleIndex,
            AudioStreamIndex: currentAudioIndex,
            BufferedRanges: [],
            SeekableRanges: defaultSeekableRanges,
            EventName: undefined,
            NowPlayingQueue: nowPlayingQueue || [{ Id: itemId, PlaylistItemId: req.body.playlistItemId || "playlistItem125" }]
        };
    } else if (intent === 'timeupdate') {
        body = {
            ...baseBody,
            IsPaused: false,
            PositionTicks: positionTicks || 90000,
            PlaybackStartTimeTicks: playbackStartTimeTicks,
            SubtitleStreamIndex: currentSubtitleIndex,
            AudioStreamIndex: currentAudioIndex,
            BufferedRanges: [],
            SeekableRanges: defaultSeekableRanges,
            EventName: 'timeupdate',
        };
    } else if (intent === 'pause') {
        body = {
            ...baseBody,
            IsPaused: true,
            PositionTicks: positionTicks || 118760670,
            PlaybackStartTimeTicks: playbackStartTimeTicks,
            SubtitleStreamIndex: currentSubtitleIndex,
            AudioStreamIndex: currentAudioIndex,
            BufferedRanges: [],
            SeekableRanges: defaultSeekableRanges,
            EventName: 'pause',
        };
    } else if (intent === 'unpause') {
        body = {
            ...baseBody,
            IsPaused: false,
            PositionTicks: positionTicks || 118760670,
            PlaybackStartTimeTicks: playbackStartTimeTicks,
            SubtitleStreamIndex: currentSubtitleIndex,
            AudioStreamIndex: currentAudioIndex,
            BufferedRanges: [],
            SeekableRanges: defaultSeekableRanges,
            EventName: 'unpause',
        };
    } else {
        return res.status(400).send("Invalid intent");
    }
    Object.keys(body).forEach(key => body[key] === undefined && delete body[key]);
    try {
        const response = await fetch(`${monobar_endpoint}/Sessions/Playing`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Emby-Token': monobar_token,
            },
            body: JSON.stringify(body)
        });
        if (response.status === 204) {
            return res.status(204).send();
        } else {
            const errorText = await response.text();
            return res.status(response.status).send({ message: 'Failed to update status', error: errorText });
        }
    } catch (e) {
        return res.status(500).send("Internal Server Error: " + e.message);
    }
});

router.delete('/status', async (req, res) => {
    const playSessionId = req.query.playSessionId;
    if (!playSessionId) {
        return res.status(400).send("Missing 'playSessionId' query parameter");
    }
    let foundKey = null;
    let foundSession = null;
    let foundQuality = null;
    for (const [key, session] of playSessionCache.entries()) {
        for (const [quality, embyId] of Object.entries(session.embySessionIds || {})) {
            if (embyId === playSessionId) {
                foundKey = key;
                foundSession = session;
                foundQuality = quality;
                break;
            }
        }
        if (foundSession) break;
    }
    if (!foundSession) {
        for (const [key, session] of playSessionCache.entries()) {
            if (session.genSessionId === playSessionId) {
                foundKey = key;
                foundSession = session;
                break;
            }
        }
        if (foundSession) {
            try {
                if (foundSession.embySessionIds && foundSession.deviceId) {
                    for (const embyId of Object.values(foundSession.embySessionIds)) {
                        await stopEmbyTranscode(foundSession.deviceId, embyId);
                    }
                }
                playSessionCache.delete(foundKey);
                return res.send({ message: 'Status deleted and all Emby transcodes stopped successfully' });
            } catch (e) {
                return res.status(500).send("Failed to stop Emby transcodes: " + e.message);
            }
        }
    } else if (foundSession && foundSession.deviceId && foundQuality) {
        try {
            await stopEmbyTranscode(foundSession.deviceId, playSessionId);
            delete foundSession.embySessionIds[foundQuality];
            const stillActive = Object.keys(foundSession.embySessionIds).length > 0;
            if (!stillActive) {
                playSessionCache.delete(foundKey);
            }
            return res.send({ message: 'Status deleted and Emby transcode stopped successfully' });
        } catch (e) {
            return res.status(500).send("Failed to stop Emby transcode: " + e.message);
        }
    }
    return res.status(404).send("Session not found in cache for this playSessionId");
});

router.get('/image', async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    const { type, id, tag } = req.query;
    if (!type || !id || !tag || type === 'undefined' || id === 'undefined' || tag === 'undefined' || type === null || id === null || tag === null) {
        return res.status(400).send("Missing or invalid required query parameters: type, id, tag");
    }
    let imageUrl = `${monobar_endpoint}/Items/${id}/Images/${type}?tag=${tag}`;
    if (type === 'Logo') {
        imageUrl += '&maxHeight=120';
    } else if (type === 'Backdrop') {
        imageUrl += 'maxWidth=1920&maxHeight=1080&quality=70';
    } else if (type === 'Thumb' || type === 'thumb') {
        imageUrl += 'maxWidth=640&maxHeight=360&quality=100';
    } else {
        const maxWidth = req.query.maxWidth || 250;
        const maxHeight = req.query.maxHeight || 375;
        const quality = req.query.quality || 100;
        imageUrl += `&maxWidth=${maxWidth}&maxHeight=${maxHeight}&quality=${quality}`;
    }
    try {
        const imageRes = await fetch(imageUrl, {
            headers: { 'X-Emby-Token': monobar_token }
        });
        if (!imageRes.ok) {
            return res.status(imageRes.status).send("Failed to fetch image from Emby");
        }
        res.setHeader('Content-Type', imageRes.headers.get('Content-Type') || 'image/jpeg');
        const arrayBuffer = await imageRes.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));
    } catch (e) {
        res.status(500).send("Internal Server Error: " + e.message);
    }
});

export default router;