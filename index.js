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

async function fetchLibraryItems({ parentId, host, sortBy, sortOrder, limit }) {
    // console.log(limit)
    let url = `${monobar_endpoint}/Users/${monobar_user}/Items?ParentId=${parentId}&Fields=BasicSyncInfo,ProductionYear,Overview&StartIndex=0&Recursive=true&Filters=IsNotFolder&IncludeImageTypes=Logo`;
    if (sortBy) {
        url += `&SortBy=${encodeURIComponent(sortBy)}`;
    }
    if (sortOrder) {
        url += `&SortOrder=${encodeURIComponent(sortOrder)}`;
    }
    if (limit) {
        url += `&Limit=${encodeURIComponent(limit)}`;
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
        if (data && data.Items) {
            data.Items.forEach(item => {
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
        return { items: data.Items || [], error: null };
    } catch (e) {
        return { error: { message: e.message }, items: [] };
    }
}

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
    res.setHeader('Cache-Control', 'public, max-age=720');
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
    if (!id) {
        return res.status(400).send("Missing 'id' query parameter");
    }
    try {
        let url = `${monobar_endpoint}/Items?Ids=${id}&IncludeItemTypes=CollectionFolder`;
        const { items, error } = await fetchLibraryItems({ parentId: id, host, sortBy, sortOrder });
        if (error) {
            return res.status(error.status || 500).send({ message: 'Error fetching library', error: error.statusText || error.message });
        }
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
        res.send({ library: libraryInfoData.Items[0], content: items });
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
        // Replace people image URLs
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

async function getEmbyPlaybackInfo({ id, maxWidth, maxHeight, maxBitrate, label, genSessionId }) {
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
                        "ManifestSubtitles": "vtt"
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
            "PlaySessionId": genSessionId
        })
    });
    if (!playbackInfoRes.ok) return null;
    const playbackInfo = await playbackInfoRes.json();
    const ms = playbackInfo.MediaSources && playbackInfo.MediaSources[0];
    if (!ms || !ms.TranscodingUrl) return null;
    return { ms, label, maxWidth, maxHeight, maxBitrate, playSessionId: playbackInfo.PlaySessionId };
}

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
            // console.log(result)
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
            if (infoData.MediaSources && infoData.MediaSources.length > 0) {
                const mediaSourceId = infoData.MediaSources[0].Id;
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
    const sessionKey = `${id}:${req.ip}`;
    let session = playSessionCache.get(sessionKey);
    if (!session) {
        session = {
            genSessionId,
            embySessionIds: {},
            deviceId: deviceId || undefined,
            lastAccessed: Date.now(),
        };
        playSessionCache.set(sessionKey, session);
    } else {
        session.lastAccessed = Date.now();
        if (deviceId) session.deviceId = deviceId;
    }
    try {
        const itemInfo = await getItemInfo({ id, host });
        console.log("Item Info:", itemInfo);
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
        console.log("Allowed qualities:", allowedQualities);
        const variantInfos = [];
        for (const q of allowedQualities) {
            const info = await getEmbyPlaybackInfo({ id, ...q, genSessionId });
            if (!info) continue;
            if (!session.deviceId) {
                if (info.ms.DeviceId) {
                    session.deviceId = info.ms.DeviceId;
                } else if (info.ms.TranscodingUrl) {
                    const urlObj = new URL(info.ms.TranscodingUrl, 'http://dummy');
                    const deviceIdFromUrl = urlObj.searchParams.get('DeviceId');
                    if (deviceIdFromUrl) session.deviceId = deviceIdFromUrl;
                }
            }
            const newPlaySessionId = info.ms.PlaySessionId || info.playSessionId;
            const prevPlaySessionId = session.embySessionIds[q.label];
            if (prevPlaySessionId && session.deviceId) {
                try {
                    await fetch(`${host}/monobar/status?deviceId=${session.deviceId}&playSessionId=${prevPlaySessionId}`, {
                        method: 'DELETE',
                    });
                } catch (e) {}
            }
            session.embySessionIds[q.label] = newPlaySessionId;
            const urlObj = info.ms.TranscodingUrl ? new URL(info.ms.TranscodingUrl, 'http://dummy') : null;
            const params = urlObj ? urlObj.searchParams : new URLSearchParams();
            params.set('PlaySessionId', newPlaySessionId);
            const variantUrl = `${host}/monobar/watch/main/playlist?id=${id}&${params.toString()}&label=${q.label}&DeviceId=${session.deviceId}`;
            const bandwidth = info.ms.Bitrate || q.maxBitrate;
            const resolution = `${q.maxWidth}x${q.maxHeight}`;
            variantInfos.push({
                url: variantUrl,
                bandwidth,
                resolution,
                label: q.label
            });
        }
        let masterM3U8 = '#EXTM3U\n';
        for (const v of variantInfos) {
            masterM3U8 += `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.resolution},NAME=\"${v.label}\"\n${v.url}\n`;
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
            // console.log("Streaming segment:", segmentResponse.url);
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
        console.error("Error fetching segment:", e);
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