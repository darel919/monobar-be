import express from "express"
import { URL, URLSearchParams } from 'url'
import { Readable } from 'stream'
import { error } from "console"
const router = express.Router()

const monobar_endpoint = process.env.MONOBAR_BACKEND
const monobar_token = process.env.MONOBAR_TOKEN
const monobar_user = "98d955f95e154ef9a99233ed4ab16831" || process.env.MONOBAR_USER

router.get('/', async(req,res) => {res.sendStatus(418)})

router.get('/ping', async (req, res) => {
    if(!req.headers['x-real-ip']) {
        return res.status(400).send("Missing x-real-ip header")
    } else {
        res.status(200).send("pong")
    }
})
router.post('/ping', async (req, res) => {
    const response = {
        callingFrom: req.headers.origin,
        viaNginxProxy: req.headers['x-nginx-proxy'] || null,
    }
    res.send(response)
})



// Watch Endpoint
router.get('/watch', async (req, res) => {
    const id = req.query.id
    const host = `${req.protocol}://${req.headers.host}`
    const isAdmin = true
    const intent = req.query.intent
    
    if (!id) {
        return res.status(400).send("Missing 'id' query parameter")
    }
    if(!intent) {
        return res.status(400).send("Missing 'intent' query parameter")
    } else {
        if(intent == 'info') {
            try {
                const info = await fetch(`${monobar_endpoint}/Users/${monobar_user}/Items/${id}/?fields=ShareLevel`, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Emby-Token': monobar_token,
                    }, 
                })
        
                if (!info.ok) {
                    return res.status(info.status).send({message: 'Error fetching item info', error: info.statusText})
                }
        
                const data = await info.json()
                res.send(data)
                
            } catch (e) {
                res.status(500).send("Internal Server Error: " + e.message)
            }
        } else if(intent == 'play') {
            try {
                const info = await fetch(`${monobar_endpoint}/Items/${id}/PlaybackInfo?UserId=${monobar_user}&StartTimeTicks=0&IsPlayback=true&AutoOpenLiveStream=true&reqformat=json`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Emby-Token': monobar_token,
                    }, 
                    body: JSON.stringify({
                        "DeviceProfile": {
                            "MaxStaticBitrate": isAdmin ? 20000000 : 4000000,
                            "MaxStreamingBitrate": isAdmin ? 20000000 : 4000000,
                            "MusicStreamingTranscodingBitrate": 384000,
                            "TranscodingProfiles": [
                                {
                                    "Container": "aac",
                                    "Type": "Audio",
                                    "AudioCodec": "aac",
                                    "Context": "Streaming",
                                    "Protocol": "hls",
                                    "MaxAudioChannels": "6",
                                    "MinSegments": "1",
                                    "BreakOnNonKeyFrames": true
                                },
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
                                },
                            ],
                            "ContainerProfiles": [],
                            "CodecProfiles": [
                                {
                                    "Type": "Video",
                                    "Codec": "h264",
                                    "Conditions": [
                                        {
                                            "Condition": "EqualsAny",
                                            "Property": "VideoProfile",
                                            "Value": "high|main|baseline|constrained baseline|high 10",
                                            "IsRequired": false
                                        },
                                        {
                                            "Condition": "LessThanEqual",
                                            "Property": "VideoLevel",
                                            "Value": "62",
                                            "IsRequired": false
                                        },
                                        {
                                            "Condition": "LessThanEqual",
                                            "Property": "Width",
                                            "Value": "854",
                                            "IsRequired": false
                                        }
                                    ]
                                },
                            {
                                "Type": "Video",
                                "Conditions": [
                                {
                                    "Condition": "LessThanEqual",
                                    "Property": "Width",
                                    "Value": "854",
                                    "IsRequired": false
                                }
                                ]
                            }
                            ],
                            "SubtitleProfiles": [
                                {
                                    "Format": "vtt",
                                    "Method": "Hls"
                                },
                                {
                                    "Format": "eia_608",
                                    "Method": "VideoSideData",
                                    "Protocol": "hls"
                                },
                                {
                                    "Format": "eia_708",
                                    "Method": "VideoSideData",
                                    "Protocol": "hls"
                                },
                                {
                                    "Format": "vtt",
                                    "Method": "External"
                                },
                                {
                                    "Format": "ass",
                                    "Method": "External"
                                },
                                {
                                    "Format": "ssa",
                                    "Method": "External"
                                }
                            ],
                            "ResponseProfiles": [
                                {
                                    "Type": "Video",
                                    "Container": "m4v",
                                    "MimeType": "video/mp4"
                                }
                            ]
                        }
                    })
                })
        
                if (!info.ok) {
                    const errorBody = await info()
                    return res.status(info.status).send(`Error fetching playback info: ${errorBody}`)
                }
        
                const data = await info.json()
        
                if (data.MediaSources && data.MediaSources.length > 0 && data.MediaSources[0].TranscodingUrl) {
                    const originalUrlString = data.MediaSources[0].TranscodingUrl
                    try {
                        const originalUrl = new URL(originalUrlString, 'http://dummy')
                        const originalQueryString = originalUrl.search
                        const newTranscodingUrl = `${host}/monobar/watch/master/playlist${originalQueryString}`
                        data.MediaSources[0].TranscodingUrl = newTranscodingUrl
                    } catch (parseError) {}
                }
        
                if(data.MediaSources && data.MediaSources.length > 0 && data.MediaSources[0].TranscodingUrl) {
                    res.redirect(data.MediaSources[0].TranscodingUrl)
                } else {
                    // res.send(data)
                    res.status(500).send({message: 'Unable to provide playback URL for this title.'})
                }
            } catch (e) {
                res.status(500).send("Internal Server Error: " + e.message)
            }
        } else {
            return res.status(400).send("Invalid 'intent' parameter.")
        }
    }
    
})
router.get('/watch/master/playlist', async (req, res) => {
    const host = `${req.protocol}://${req.headers.host}`
    const deviceId = req.query.DeviceId
    const mediaSourceId = req.query.MediaSourceId
    const playSessionId = req.query.PlaySessionId
    const apiKey = req.query.api_key
    const videoCodec = req.query.VideoCodec
    const audioCodec = req.query.AudioCodec
    const videoBitrate = req.query.VideoBitrate
    const audioBitrate = req.query.AudioBitrate
    const maxWidth = req.query.MaxWidth
    const audioStreamIndex = req.query.AudioStreamIndex
    const subtitleStreamIndex = req.query.SubtitleStreamIndex
    const subtitleMethod = req.query.SubtitleMethod
    const transcodingMaxAudioChannels = req.query.TranscodingMaxAudioChannels
    const segmentContainer = req.query.SegmentContainer
    const minSegments = req.query.MinSegments
    const breakOnNonKeyFrames = req.query.BreakOnNonKeyFrames
    const subtitleStreamIndexes = req.query.SubtitleStreamIndexes
    const manifestSubtitles = req.query.ManifestSubtitles
    const h264Profile = req.query['h264-profile']
    const h264Level = req.query['h264-level']
    const transcodeReasons = req.query.TranscodeReasons
    const id = mediaSourceId
    const filename = 'master.m3u8'
    if (!id) {
        return res.status(400).send("Missing 'MediaSourceId' query parameter")
    }
    // Build query string explicitly
    const queryParams = new URLSearchParams();
    if (deviceId !== undefined) queryParams.set('DeviceId', deviceId)
    if (mediaSourceId !== undefined) queryParams.set('MediaSourceId', mediaSourceId)
    if (playSessionId !== undefined) queryParams.set('PlaySessionId', playSessionId)
    if (apiKey !== undefined) queryParams.set('api_key', apiKey)
    if (videoCodec !== undefined) queryParams.set('VideoCodec', videoCodec)
    if (audioCodec !== undefined) queryParams.set('AudioCodec', audioCodec)
    if (videoBitrate !== undefined) queryParams.set('VideoBitrate', videoBitrate)
    if (audioBitrate !== undefined) queryParams.set('AudioBitrate', audioBitrate)
    if (maxWidth !== undefined) queryParams.set('MaxWidth', maxWidth)
    if (audioStreamIndex !== undefined) queryParams.set('AudioStreamIndex', audioStreamIndex)
    if (subtitleStreamIndex !== undefined) queryParams.set('SubtitleStreamIndex', subtitleStreamIndex)
    if (subtitleMethod !== undefined) queryParams.set('SubtitleMethod', subtitleMethod)
    if (transcodingMaxAudioChannels !== undefined) queryParams.set('TranscodingMaxAudioChannels', transcodingMaxAudioChannels)
    if (segmentContainer !== undefined) queryParams.set('SegmentContainer', segmentContainer)
    if (minSegments !== undefined) queryParams.set('MinSegments', minSegments)
    if (breakOnNonKeyFrames !== undefined) queryParams.set('BreakOnNonKeyFrames', breakOnNonKeyFrames)
    if (subtitleStreamIndexes !== undefined) queryParams.set('SubtitleStreamIndexes', subtitleStreamIndexes)
    if (manifestSubtitles !== undefined) queryParams.set('ManifestSubtitles', manifestSubtitles)
    if (h264Profile !== undefined) queryParams.set('h264-profile', h264Profile)
    if (h264Level !== undefined) queryParams.set('h264-level', h264Level)
    if (transcodeReasons !== undefined) queryParams.set('TranscodeReasons', transcodeReasons)
    const originalMasterUrl = `${monobar_endpoint}/videos/${id}/${filename}?${queryParams.toString()}`
    try {
        const masterResponse = await fetch(originalMasterUrl)
        if (!masterResponse.ok) {
            const errorBody = await masterResponse.text()
            return res.status(masterResponse.status).send(`Error fetching master playlist: ${masterResponse.statusText}`)
        }
        const m3u8Content = await masterResponse.text()
        const lines = m3u8Content.split('\n')
        const modifiedLines = lines.filter(line => {
            if (line.trim().startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES')) return false
            return true
        }).map(line => {
            line = line.trim()
            if (line && !line.startsWith('#') && line.includes('main.m3u8')) {
                const [mainPathRelative, mainQueryString] = line.split('?')
                // Parse original main.m3u8 query and build new one explicitly
                const mainParams = new URLSearchParams(mainQueryString)
                const newMainParams = new URLSearchParams()
                if (deviceId !== undefined) newMainParams.set('DeviceId', deviceId)
                if (mediaSourceId !== undefined) newMainParams.set('MediaSourceId', mediaSourceId)
                if (playSessionId !== undefined) newMainParams.set('PlaySessionId', playSessionId)
                if (apiKey !== undefined) newMainParams.set('api_key', apiKey)
                if (videoCodec !== undefined) newMainParams.set('VideoCodec', videoCodec)
                if (audioCodec !== undefined) newMainParams.set('AudioCodec', audioCodec)
                if (videoBitrate !== undefined) newMainParams.set('VideoBitrate', videoBitrate)
                if (audioBitrate !== undefined) newMainParams.set('AudioBitrate', audioBitrate)
                if (maxWidth !== undefined) newMainParams.set('MaxWidth', maxWidth)
                if (audioStreamIndex !== undefined) newMainParams.set('AudioStreamIndex', audioStreamIndex)
                if (subtitleStreamIndex !== undefined) newMainParams.set('SubtitleStreamIndex', subtitleStreamIndex)
                if (subtitleMethod !== undefined) newMainParams.set('SubtitleMethod', subtitleMethod)
                if (transcodingMaxAudioChannels !== undefined) newMainParams.set('TranscodingMaxAudioChannels', transcodingMaxAudioChannels)
                if (segmentContainer !== undefined) newMainParams.set('SegmentContainer', segmentContainer)
                if (minSegments !== undefined) newMainParams.set('MinSegments', minSegments)
                if (breakOnNonKeyFrames !== undefined) newMainParams.set('BreakOnNonKeyFrames', breakOnNonKeyFrames)
                if (subtitleStreamIndexes !== undefined) newMainParams.set('SubtitleStreamIndexes', subtitleStreamIndexes)
                if (manifestSubtitles !== undefined) newMainParams.set('ManifestSubtitles', manifestSubtitles)
                if (h264Profile !== undefined) newMainParams.set('h264-profile', h264Profile)
                if (h264Level !== undefined) newMainParams.set('h264-level', h264Level)
                if (transcodeReasons !== undefined) newMainParams.set('TranscodeReasons', transcodeReasons)
                newMainParams.set('id', id)
                newMainParams.set('filename', 'main.m3u8')
                const newMainUrl = `${host}/monobar/watch/main/playlist?${newMainParams.toString()}`
                return newMainUrl
            }
            return line
        })
        const modifiedM3u8Content = modifiedLines.join('\n')
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
        res.send(modifiedM3u8Content)
    } catch (e) {
        res.status(500).send("Internal Server Error: " + e.message)
    }
})
router.get('/watch/main/playlist', async (req, res) => {
    const deviceId = req.query.DeviceId
    const mediaSourceId = req.query.MediaSourceId
    const playSessionId = req.query.PlaySessionId
    const apiKey = req.query.api_key
    const videoCodec = req.query.VideoCodec
    const audioCodec = req.query.AudioCodec
    const videoBitrate = req.query.VideoBitrate
    const audioBitrate = req.query.AudioBitrate
    const maxWidth = req.query.MaxWidth
    const audioStreamIndex = req.query.AudioStreamIndex
    const subtitleStreamIndex = req.query.SubtitleStreamIndex
    const subtitleMethod = req.query.SubtitleMethod
    const transcodingMaxAudioChannels = req.query.TranscodingMaxAudioChannels
    const segmentContainer = req.query.SegmentContainer
    const minSegments = req.query.MinSegments
    const breakOnNonKeyFrames = req.query.BreakOnNonKeyFrames
    const subtitleStreamIndexes = req.query.SubtitleStreamIndexes
    const manifestSubtitles = req.query.ManifestSubtitles
    const h264Profile = req.query['h264-profile']
    const h264Level = req.query['h264-level']
    const transcodeReasons = req.query.TranscodeReasons
    const id = req.query.id
    const filename = req.query.filename
    if (!id || !filename) {
        return res.status(400).send("Missing 'id' or 'filename' query parameter")
    }
    // Build query string explicitly
    const queryParams = new URLSearchParams();
    if (deviceId !== undefined) queryParams.set('DeviceId', deviceId)
    if (mediaSourceId !== undefined) queryParams.set('MediaSourceId', mediaSourceId)
    if (playSessionId !== undefined) queryParams.set('PlaySessionId', playSessionId)
    if (apiKey !== undefined) queryParams.set('api_key', apiKey)
    if (videoCodec !== undefined) queryParams.set('VideoCodec', videoCodec)
    if (audioCodec !== undefined) queryParams.set('AudioCodec', audioCodec)
    if (videoBitrate !== undefined) queryParams.set('VideoBitrate', videoBitrate)
    if (audioBitrate !== undefined) queryParams.set('AudioBitrate', audioBitrate)
    if (maxWidth !== undefined) queryParams.set('MaxWidth', maxWidth)
    if (audioStreamIndex !== undefined) queryParams.set('AudioStreamIndex', audioStreamIndex)
    if (subtitleStreamIndex !== undefined) queryParams.set('SubtitleStreamIndex', subtitleStreamIndex)
    if (subtitleMethod !== undefined) queryParams.set('SubtitleMethod', subtitleMethod)
    if (transcodingMaxAudioChannels !== undefined) queryParams.set('TranscodingMaxAudioChannels', transcodingMaxAudioChannels)
    if (segmentContainer !== undefined) queryParams.set('SegmentContainer', segmentContainer)
    if (minSegments !== undefined) queryParams.set('MinSegments', minSegments)
    if (breakOnNonKeyFrames !== undefined) queryParams.set('BreakOnNonKeyFrames', breakOnNonKeyFrames)
    if (subtitleStreamIndexes !== undefined) queryParams.set('SubtitleStreamIndexes', subtitleStreamIndexes)
    if (manifestSubtitles !== undefined) queryParams.set('ManifestSubtitles', manifestSubtitles)
    if (h264Profile !== undefined) queryParams.set('h264-profile', h264Profile)
    if (h264Level !== undefined) queryParams.set('h264-level', h264Level)
    if (transcodeReasons !== undefined) queryParams.set('TranscodeReasons', transcodeReasons)
    const host = `${req.protocol}://${req.headers.host}`
    const baseMonobarUrl = `${monobar_endpoint}/videos/${id}`
    const originalM3u8Url = `${baseMonobarUrl}/${filename}?${queryParams.toString()}`
    try {
        const watchPointResponse = await fetch(originalM3u8Url)
        if (!watchPointResponse.ok) {
            const errorBody = await watchPointResponse.text()
            return res.status(watchPointResponse.status).send(`Error fetching M3U8: ${watchPointResponse.statusText}`)
        }
        const m3u8Content = await watchPointResponse.text()
        const lines = m3u8Content.split('\n')
        const modifiedLines = lines.map(line => {
            line = line.trim()
            if (line && !line.startsWith('#')) {
                const [segmentPath, segmentQueryString] = line.split('?')
                // Parse original segment query and build new one explicitly
                const segmentParams = new URLSearchParams(segmentQueryString)
                const newSegmentParams = new URLSearchParams()
                if (deviceId !== undefined) newSegmentParams.set('DeviceId', deviceId)
                if (mediaSourceId !== undefined) newSegmentParams.set('MediaSourceId', mediaSourceId)
                if (playSessionId !== undefined) newSegmentParams.set('PlaySessionId', playSessionId)
                if (apiKey !== undefined) newSegmentParams.set('api_key', apiKey)
                if (videoCodec !== undefined) newSegmentParams.set('VideoCodec', videoCodec)
                if (audioCodec !== undefined) newSegmentParams.set('AudioCodec', audioCodec)
                if (videoBitrate !== undefined) newSegmentParams.set('VideoBitrate', videoBitrate)
                if (audioBitrate !== undefined) newSegmentParams.set('AudioBitrate', audioBitrate)
                if (maxWidth !== undefined) newSegmentParams.set('MaxWidth', maxWidth)
                if (audioStreamIndex !== undefined) newSegmentParams.set('AudioStreamIndex', audioStreamIndex)
                if (subtitleStreamIndex !== undefined) newSegmentParams.set('SubtitleStreamIndex', subtitleStreamIndex)
                if (subtitleMethod !== undefined) newSegmentParams.set('SubtitleMethod', subtitleMethod)
                if (transcodingMaxAudioChannels !== undefined) newSegmentParams.set('TranscodingMaxAudioChannels', transcodingMaxAudioChannels)
                if (segmentContainer !== undefined) newSegmentParams.set('SegmentContainer', segmentContainer)
                if (minSegments !== undefined) newSegmentParams.set('MinSegments', minSegments)
                if (breakOnNonKeyFrames !== undefined) newSegmentParams.set('BreakOnNonKeyFrames', breakOnNonKeyFrames)
                if (subtitleStreamIndexes !== undefined) newSegmentParams.set('SubtitleStreamIndexes', subtitleStreamIndexes)
                if (manifestSubtitles !== undefined) newSegmentParams.set('ManifestSubtitles', manifestSubtitles)
                if (h264Profile !== undefined) newSegmentParams.set('h264-profile', h264Profile)
                if (h264Level !== undefined) newSegmentParams.set('h264-level', h264Level)
                if (transcodeReasons !== undefined) newSegmentParams.set('TranscodeReasons', transcodeReasons)
                newSegmentParams.set('videoId', id)
                return `${host}/monobar/watch/main/segment/${segmentPath}?${newSegmentParams.toString()}`
            }
            return line
        })
        const modifiedM3u8Content = modifiedLines.join('\n')
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
        res.send(modifiedM3u8Content)
    } catch (e) {
        res.status(500).send("Internal Server Error: " + e.message)
    }
})
router.get('/watch/main/segment/*', async (req, res) => {
    const segmentPath = req.params[0]
    const videoId = req.query.videoId
    if (!videoId) {
        return res.status(400).send("Missing 'videoId' query parameter")
    }
    if (!segmentPath) {
        return res.status(400).send("Missing segment path")
    }
    const originalQuery = new URLSearchParams(req.query)
    originalQuery.delete('videoId')
    const originalQueryString = originalQuery.toString()
    const originalSegmentUrl = `${monobar_endpoint}/videos/${videoId}/${segmentPath}${originalQueryString ? '?' + originalQueryString : ''}`
    try {
        const segmentResponse = await fetch(originalSegmentUrl)
        if (!segmentResponse.ok) {
            const errorBody = await segmentResponse.text()
            return res.status(segmentResponse.status).send(`Error fetching segment: ${segmentResponse.statusText}`)
        }
        res.setHeader('Content-Type', segmentResponse.headers.get('Content-Type') || 'video/mp2t')
        const contentLength = segmentResponse.headers.get('Content-Length')
        if (contentLength) {
            res.setHeader('Content-Length', contentLength)
        }
        if (segmentResponse.body) {
            const nodeStream = Readable.fromWeb(segmentResponse.body)
            nodeStream.pipe(res)
            await new Promise((resolve, reject) => {
                nodeStream.on('end', resolve)
                nodeStream.on('error', reject)
                res.on('close', () => {
                    nodeStream.destroy()
                    resolve()
                })
                res.on('error', reject)
            })
        } else {
            res.end()
        }
    } catch (e) {
        if (!res.headersSent) {
            res.status(500).send("Internal Server Error")
        } else {
            res.end()
        }
    }
})

export default router