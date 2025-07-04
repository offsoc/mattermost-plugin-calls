// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// eslint-disable max-lines
// eslint-disable-next-line simple-import-sort/imports
import {parseRTCStats, RTCMonitor, RTCPeer} from '@mattermost/calls-common';
import type {EmojiData, CallsClientJoinData} from '@mattermost/calls-common/lib/types';

import {EventEmitter} from 'events';

import {zlibSync, strToU8} from 'fflate';
import {AudioDevices, CallsClientConfig, CallsClientStats, TrackInfo} from 'src/types/types';

import {logDebug, logErr, logInfo, logWarn, persistClientLogs} from './log';
import {getScreenStream, getPersistentStorage} from './utils';
import {WebSocketClient, WebSocketError, WebSocketErrorType} from './websocket';
import {
    STORAGE_CALLS_CLIENT_STATS_KEY,
    STORAGE_CALLS_DEFAULT_AUDIO_INPUT_KEY,
    STORAGE_CALLS_DEFAULT_AUDIO_OUTPUT_KEY,
} from 'src/constants';

export const AudioInputPermissionsError = new Error('missing audio input permissions');
export const AudioInputMissingError = new Error('no audio input available');
export const rtcPeerErr = new Error('rtc peer error');
export const rtcPeerTimeoutErr = new Error('timed out waiting for rtc connection');
export const rtcPeerCloseErr = new Error('rtc peer close');
export const insecureContextErr = new Error('insecure context');
export const userRemovedFromChannelErr = new Error('user was removed from channel');
export const userLeftChannelErr = new Error('user has left channel');

const rtcMonitorInterval = 10000;

export default class CallsClient extends EventEmitter {
    public channelID: string;
    private readonly config: CallsClientConfig;
    private peer: RTCPeer | null;
    public ws: WebSocketClient | null;
    private localScreenTrack: MediaStreamTrack | null = null;
    private remoteScreenTrack: MediaStreamTrack | null = null;
    private remoteVoiceTracks: MediaStreamTrack[];
    public currentAudioInputDevice: MediaDeviceInfo | null = null;
    public currentAudioOutputDevice: MediaDeviceInfo | null = null;
    private voiceTrackAdded: boolean;
    private streams: MediaStream[];
    private stream: MediaStream | null;
    private audioDevices: AudioDevices;
    public audioTrack: MediaStreamTrack | null;
    private readonly onDeviceChange: () => void;
    private readonly onBeforeUnload: () => void;
    private closed = false;
    private connected = false;
    public initTime = Date.now();
    private rtcMonitor: RTCMonitor | null = null;
    private av1Codec: RTCRtpCodecCapability | null = null;

    constructor(config: CallsClientConfig) {
        logDebug('creating new calls client', JSON.stringify(config));
        super();
        this.ws = null;
        this.peer = null;
        this.audioTrack = null;
        this.currentAudioInputDevice = null;
        this.currentAudioInputDevice = null;
        this.voiceTrackAdded = false;
        this.streams = [];
        this.remoteVoiceTracks = [];
        this.stream = null;
        this.audioDevices = {inputs: [], outputs: []};
        this.channelID = '';
        this.config = config;
        this.onDeviceChange = async () => {
            await this.updateDevices();
        };
        this.onBeforeUnload = () => {
            logDebug('unload');
            this.disconnect();
        };
        window.addEventListener('beforeunload', this.onBeforeUnload);
    }

    private async updateDevices() {
        logDebug('a/v device change detected');

        try {
            const devices = await navigator.mediaDevices.enumerateDevices();

            const inputs = devices.filter((device) => device.kind === 'audioinput');
            const outputs = devices.filter((device) => device.kind === 'audiooutput');

            this.audioDevices = {
                inputs,
                outputs,
            };

            if (this.currentAudioInputDevice) {
                await this.handleAudioDeviceFallback('input');
            }

            if (this.currentAudioOutputDevice) {
                await this.handleAudioDeviceFallback('output');
            }

            this.emit('devicechange', this.audioDevices);
        } catch (err) {
            logErr(err);
        }
    }

    private async handleAudioDeviceFallback(deviceType: string) {
        const currentDevice = deviceType === 'input' ? this.currentAudioInputDevice : this.currentAudioOutputDevice;
        const devices = deviceType === 'input' ? this.audioDevices.inputs : this.audioDevices.outputs;
        const missingCurrentDevice = !devices.some(device => currentDevice?.deviceId === device.deviceId);

        // Fallback to the system default device if the current one is not available.
        if (missingCurrentDevice && devices.length > 0) {
            logDebug(`selected audio ${deviceType} device not available, falling back to system default`, currentDevice, devices[0]);

            if (deviceType === 'input') {
                await this.setAudioInputDevice(devices[0], false);
            } else if (deviceType === 'output') {
                await this.setAudioOutputDevice(devices[0], false);
            }

            this.emit('devicefallback', devices[0]);

            return;
        }

        // If the user selected (i.g. stored) device comes back, we want to switch to it.
        const selectedDevice = this.getSelectedAudioDevice(deviceType);
        if (selectedDevice && selectedDevice.label !== currentDevice?.label) {
            logDebug(`selected audio ${deviceType} device is back, switching`, selectedDevice, currentDevice);

            if (deviceType === 'input') {
                await this.setAudioInputDevice(selectedDevice, false);
            } else if (deviceType === 'output') {
                await this.setAudioOutputDevice(selectedDevice, false);
            }

            this.emit('devicefallback', selectedDevice);
        }
    }

    private getSelectedAudioDevice(deviceType: string) {
        let selectedDevice: {deviceId: string; label?: string} = {
            deviceId: '',
        };

        const deviceKey = deviceType === 'input' ? STORAGE_CALLS_DEFAULT_AUDIO_INPUT_KEY : STORAGE_CALLS_DEFAULT_AUDIO_OUTPUT_KEY;

        const data = window.localStorage.getItem(deviceKey);

        if (data) {
            try {
                selectedDevice = JSON.parse(data);
            } catch {
                // Backwards compatibility case when we used to store the device id directly (before MM-63274).
                selectedDevice = {
                    deviceId: data,
                };
            }
        }

        if (!selectedDevice.deviceId) {
            return null;
        }

        let devices = deviceType === 'input' ? this.audioDevices.inputs : this.audioDevices.outputs;
        devices = devices.filter((dev) => {
            return dev.deviceId === selectedDevice.deviceId || dev.label === selectedDevice.label;
        });

        if (devices.length > 1) {
            // If there are multiple devices with the same label, we select the selected device by ID.
            logInfo(`getSelectedAudioDevice: multiple audio ${deviceType} devices found with the same label, checking by id`, devices);
            return devices.find((dev) => dev.deviceId === selectedDevice.deviceId) || null;
        } else if (devices.length === 1) {
            logDebug(`getSelectedAudioDevice: found selected audio ${deviceType} device to use`, devices[0]);
            return devices[0];
        }

        logDebug(`getSelectedAudioDevice: audio ${deviceType} device not found`, selectedDevice);

        return null;
    }

    private async initAudio(deviceId?: string) {
        const audioOptions: MediaTrackConstraints = {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
        };

        if (deviceId) {
            audioOptions.deviceId = {
                exact: deviceId,
            };
        }

        const selectedAudioInputDevice = this.getSelectedAudioDevice('input');
        if (selectedAudioInputDevice) {
            audioOptions.deviceId = {
                exact: selectedAudioInputDevice.deviceId,
            };
            this.currentAudioInputDevice = selectedAudioInputDevice;
        }

        const selectedAudioOutputDevice = this.getSelectedAudioDevice('output');
        if (selectedAudioOutputDevice) {
            this.currentAudioOutputDevice = selectedAudioOutputDevice;
        }

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: false,
                audio: audioOptions,
            });

            // updating the devices again cause some browsers (e.g Firefox) will
            // return empty labels unless permissions were previously granted.
            await this.updateDevices();

            this.audioTrack = this.stream.getAudioTracks()[0];
            this.streams.push(this.stream);

            this.audioTrack.enabled = false;

            this.emit('initaudio');
        } catch (err) {
            logErr(err);
            if (this.audioDevices.inputs.length > 0) {
                throw AudioInputPermissionsError;
            }
            throw AudioInputMissingError;
        }
    }

    private collectICEStats() {
        const start = Date.now();
        const seenMap: {[key: string]: string} = {};

        const gatherStats = async () => {
            if (!this.ws || !this.peer) {
                return;
            }

            try {
                const stats = parseRTCStats(await this.peer.getStats()).iceStats;
                for (const state of Object.keys(stats)) {
                    for (const pair of stats[state]) {
                        const seenState = seenMap[pair.id];
                        seenMap[pair.id] = pair.state;

                        if (seenState !== pair.state) {
                            logDebug('ice candidate pair stats', JSON.stringify(pair));
                        }

                        if (seenState === 'succeeded' || state !== 'succeeded') {
                            continue;
                        }

                        if (!pair.local || !pair.remote) {
                            continue;
                        }

                        this.ws.send('metric', {
                            metric_name: 'client_ice_candidate_pair',
                            data: JSON.stringify({
                                state: pair.state,
                                local: {
                                    type: pair.local.candidateType,
                                    protocol: pair.local.protocol,
                                },
                                remote: {
                                    type: pair.remote.candidateType,
                                    protocol: pair.remote.protocol,
                                },
                            }),
                        });
                    }
                }
            } catch (err) {
                logErr('failed to parse ICE stats', err);
            }

            // Repeat the check for at most 30 seconds.
            if (Date.now() < start + 30000) {
                // We check every two seconds.
                setTimeout(gatherStats, 2000);
            }
        };

        gatherStats();
    }

    public async init(joinData: CallsClientJoinData) {
        this.channelID = joinData.channelID;

        if (this.config.enableAV1 && !this.config.simulcast) {
            this.av1Codec = await RTCPeer.getVideoCodec('video/AV1');
            if (this.av1Codec) {
                logDebug('client has AV1 support');
                joinData.av1Support = true;
            }
        } else if (this.config.enableAV1 && this.config.simulcast) {
            logWarn('both simulcast and av1 support are enabled');
        }

        if (this.config.dcSignaling) {
            logDebug('enabling DC signaling on client');
            joinData.dcSignaling = true;
        }

        if (!window.isSecureContext) {
            throw insecureContextErr;
        }

        await this.updateDevices();
        navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);

        try {
            await this.initAudio();
            if (this.closed) {
                this.cleanup();
                return;
            }
        } catch (err) {
            this.emit('error', err);
        }

        const ws = new WebSocketClient(this.config.wsURL, this.config.authToken);
        this.ws = ws;

        ws.on('error', (err: WebSocketError) => {
            logErr('ws error', err);
            switch (err.type) {
            case WebSocketErrorType.Native:
                break;
            case WebSocketErrorType.ReconnectTimeout:
                this.ws = null;
                this.disconnect(err);
                break;
            case WebSocketErrorType.Join:
                this.disconnect(err);
                break;
            default:
            }
        });

        ws.on('close', (code?: number) => {
            logDebug(`ws close: ${code}`);
        });

        ws.on('open', (originalConnID: string, prevConnID: string, isReconnect: boolean) => {
            if (isReconnect) {
                logDebug('ws reconnect, sending reconnect msg');
                ws.send('reconnect', {
                    channelID: joinData.channelID,
                    originalConnID,
                    prevConnID,
                });
            } else {
                logDebug('ws open, sending join msg');
                ws.send('join', joinData);
            }
        });

        ws.on('join', async () => {
            logDebug('join ack received, initializing connection');

            const peer = new RTCPeer({
                iceServers: this.config.iceServers || [],
                logger: {
                    logDebug,
                    logErr,
                    logWarn,
                    logInfo,
                },
                simulcast: this.config.simulcast,
                dcSignaling: this.config.dcSignaling,
                dcLocking: this.config.dcLocking,
            });

            this.peer = peer;

            this.collectICEStats();

            this.rtcMonitor = new RTCMonitor({
                peer,
                logger: {
                    logDebug,
                    logErr,
                    logWarn,
                    logInfo,
                },
                monitorInterval: rtcMonitorInterval,
            });
            this.rtcMonitor.on('mos', (mos: number) => this.emit('mos', mos));

            const sdpHandler = (sdp: RTCSessionDescription) => {
                const payload = JSON.stringify(sdp);

                // SDP data is compressed using zlib since it's text based
                // and can grow substantially, potentially hitting the maximum
                // message size (4KB).
                ws.send('sdp', {
                    data: zlibSync(strToU8(payload)),
                }, true);
            };
            peer.on('offer', sdpHandler);
            peer.on('answer', sdpHandler);

            peer.on('candidate', (candidate) => {
                ws.send('ice', {
                    data: JSON.stringify(candidate),
                });
            });

            peer.on('error', (err) => {
                logErr('peer error', err);
                if (!this.closed) {
                    this.disconnect(err === rtcPeerTimeoutErr.message ? rtcPeerTimeoutErr : rtcPeerErr);
                }
            });

            peer.on('stream', (remoteStream) => {
                logDebug('new remote stream received', remoteStream.id);
                for (const track of remoteStream.getTracks()) {
                    logDebug('remote track', track.kind, track.id);
                }

                this.streams.push(remoteStream);

                if (remoteStream.getAudioTracks().length > 0) {
                    this.emit('remoteVoiceStream', remoteStream);
                    this.remoteVoiceTracks.push(...remoteStream.getAudioTracks());
                } else if (remoteStream.getVideoTracks().length > 0) {
                    this.emit('remoteScreenStream', remoteStream);
                    this.remoteScreenTrack = remoteStream.getVideoTracks()[0];
                }
            });

            peer.on('connect', () => {
                logDebug('rtc connected');

                this.emit('connect');
                this.rtcMonitor?.start();
                this.connected = true;
            });

            peer.on('close', () => {
                logDebug('rtc closed');

                if (!this.closed) {
                    this.disconnect(rtcPeerCloseErr);
                }
            });
        });

        ws.on('message', async ({data}) => {
            const msg = JSON.parse(data);
            if (!msg) {
                return;
            }
            if (msg.type === 'answer' || msg.type === 'offer' || msg.type === 'candidate') {
                if (this.peer) {
                    await this.peer.signal(data);
                }
            }
        });
    }

    public destroy() {
        this.removeAllListeners('close');
        this.removeAllListeners('connect');
        this.removeAllListeners('remoteVoiceStream');
        this.removeAllListeners('remoteScreenStream');
        this.removeAllListeners('localScreenStream');
        this.removeAllListeners('devicechange');
        this.removeAllListeners('devicefallback');
        this.removeAllListeners('error');
        this.removeAllListeners('initaudio');
        this.removeAllListeners('mute');
        this.removeAllListeners('unmute');
        this.removeAllListeners('raise_hand');
        this.removeAllListeners('lower_hand');
        this.removeAllListeners('mos');
        window.removeEventListener('beforeunload', this.onBeforeUnload);
        navigator.mediaDevices?.removeEventListener('devicechange', this.onDeviceChange);
        persistClientLogs();
    }

    public async setAudioInputDevice(device: MediaDeviceInfo, store: boolean = true) {
        if (!this.peer) {
            return;
        }

        if (store) {
            window.localStorage.setItem(STORAGE_CALLS_DEFAULT_AUDIO_INPUT_KEY, JSON.stringify(device));
        }
        this.currentAudioInputDevice = device;

        // We emit this event so it's easier to keep state in sync between widget and pop out.
        this.emit('devicechange', this.audioDevices);

        // If no track/stream exists we need to initialize again.
        // This edge case can happen if the default input device failed
        // but there are potentially more valid ones to choose (MM-48822).
        if (!this.audioTrack || !this.stream) {
            await this.initAudio(device.deviceId);
            return;
        }

        const isEnabled = this.audioTrack.enabled;
        this.audioTrack.stop();
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: {
                deviceId: {
                    exact: device.deviceId,
                },
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true,
            },
        });
        this.streams.push(newStream);
        const newTrack = newStream.getAudioTracks()[0];
        this.stream.removeTrack(this.audioTrack);
        this.stream.addTrack(newTrack);
        newTrack.enabled = isEnabled;
        if (isEnabled) {
            if (this.voiceTrackAdded) {
                logDebug('replacing track to peer', newTrack.id);
                this.peer.replaceTrack(this.audioTrack.id, newTrack);
            } else {
                logDebug('adding track to peer', newTrack.id, this.stream.id);
                await this.peer.addTrack(newTrack, this.stream);
            }
        } else {
            this.voiceTrackAdded = false;
        }
        this.audioTrack = newTrack;
    }

    public async setAudioOutputDevice(device: MediaDeviceInfo, store: boolean = true) {
        if (!this.peer) {
            return;
        }

        if (store) {
            window.localStorage.setItem(STORAGE_CALLS_DEFAULT_AUDIO_OUTPUT_KEY, JSON.stringify(device));
        }
        this.currentAudioOutputDevice = device;

        // We emit this event so it's easier to keep state in sync between widget and pop out.
        this.emit('devicechange', this.audioDevices);
    }

    public disconnect(err?: Error) {
        logDebug('disconnect');

        if (this.closed) {
            logErr('client already disconnected');
            return;
        }

        this.rtcMonitor?.stop();

        this.closed = true;
        if (this.peer) {
            this.getStats().then((stats) => {
                getPersistentStorage().setItem(STORAGE_CALLS_CLIENT_STATS_KEY, JSON.stringify(stats));
            }).catch((statsErr) => {
                logErr(statsErr);
            });
            this.peer.destroy();
            this.peer = null;
        }

        this.cleanup();

        if (this.ws) {
            this.ws.send('leave');
            this.ws.close();
            this.ws = null;
        }

        this.emit('close', err);
    }

    private cleanup() {
        this.streams.forEach((s) => {
            s.getTracks().forEach((track) => {
                track.stop();
                track.dispatchEvent(new Event('ended'));
            });
        });
    }

    public mute() {
        if (!this.peer || !this.audioTrack || !this.stream) {
            return;
        }

        logDebug('replacing track to peer', null);

        // @ts-ignore: we actually mean (and need) to pass null here
        this.peer.replaceTrack(this.audioTrack.id, null);

        this.audioTrack.enabled = false;

        this.emit('mute');

        if (this.ws) {
            this.ws.send('mute');
        }
    }

    public async unmute() {
        if (!this.peer) {
            return;
        }

        if (!this.audioTrack) {
            try {
                await this.initAudio();
            } catch (err) {
                this.emit('error', err);
                return;
            }
        }

        // NOTE: we purposely clear the monitor's stats cache upon unmuting
        // in order to skip some calculations since upon muting we actually
        // stop sending packets which would result in stats to be skewed as
        // soon as we resume sending.
        // This is not perfect but it avoids having to constantly send
        // silence frames when muted.
        this.rtcMonitor?.clearCache();

        if (this.audioTrack) {
            if (this.voiceTrackAdded) {
                logDebug('replacing track to peer', this.audioTrack.id);
                this.peer.replaceTrack(this.audioTrack.id, this.audioTrack);
            } else if (this.stream) {
                logDebug('adding track to peer', this.audioTrack.id, this.stream.id);
                await this.peer.addTrack(this.audioTrack, this.stream);
                this.voiceTrackAdded = true;
            }
            this.audioTrack.enabled = true;
        }

        this.emit('unmute');

        if (this.ws) {
            this.ws.send('unmute');
        }
    }

    public getLocalScreenStream(): MediaStream|null {
        if (!this.localScreenTrack) {
            return null;
        }
        return new MediaStream([this.localScreenTrack]);
    }

    public getRemoteScreenStream(): MediaStream|null {
        if (!this.remoteScreenTrack || this.remoteScreenTrack.readyState !== 'live') {
            return null;
        }
        return new MediaStream([this.remoteScreenTrack]);
    }

    public getRemoteVoiceTracks(): MediaStreamTrack[] {
        const tracks = [];
        for (const track of this.remoteVoiceTracks) {
            if (track.readyState === 'live') {
                tracks.push(track);
            }
        }
        return tracks;
    }

    public async setScreenStream(screenStream: MediaStream) {
        if (!this.ws || !this.peer || this.localScreenTrack || !screenStream) {
            return;
        }

        const screenTrack = screenStream.getVideoTracks()[0];
        this.localScreenTrack = screenTrack;

        const screenAudioTrack = screenStream.getAudioTracks()[0];

        if (screenAudioTrack) {
            screenStream = new MediaStream([screenTrack, screenAudioTrack]);
        } else {
            screenStream = new MediaStream([screenTrack]);
        }

        this.streams.push(screenStream);

        screenTrack.onended = async () => {
            if (screenAudioTrack) {
                screenAudioTrack.stop();
            }

            this.localScreenTrack = null;

            if (!this.ws || !this.peer) {
                return;
            }

            await this.peer.removeTrack(screenTrack.id);
            this.ws.send('screen_off');
        };

        logDebug('adding stream to peer', screenStream.id);

        // Always send a fallback track (VP8 encoded) for receivers that don't yet support AV1.
        await this.peer.addStream(screenStream);

        if (this.config.enableAV1 && this.av1Codec) {
            logDebug('AV1 supported, sending track', this.av1Codec);
            await this.peer.addStream(screenStream, [{
                codec: this.av1Codec,
            }]);
        }

        this.ws.send('screen_on', {
            data: JSON.stringify({
                screenStreamID: screenStream.id,
            }),
        });

        this.emit('localScreenStream', screenStream);
    }

    public async shareScreen(sourceID?: string, withAudio?: boolean) {
        if (!this.ws || !this.peer) {
            return null;
        }

        const screenStream = await getScreenStream(sourceID, withAudio);
        if (screenStream === null) {
            return null;
        }

        await this.setScreenStream(screenStream);

        return screenStream;
    }

    public unshareScreen() {
        if (!this.ws || !this.localScreenTrack) {
            return;
        }

        this.localScreenTrack.stop();
        this.localScreenTrack.dispatchEvent(new Event('ended'));
        this.localScreenTrack = null;
    }

    public raiseHand() {
        this.emit('raise_hand');
        this.ws?.send('raise_hand');
    }

    public unraiseHand() {
        this.emit('lower_hand');
        this.ws?.send('unraise_hand');
    }

    public sendUserReaction(data: EmojiData) {
        this.ws?.send('react', {
            data: JSON.stringify(data),
        });
    }

    public async getStats(): Promise<CallsClientStats | null> {
        if (!this.peer) {
            throw new Error('not connected');
        }

        const tracksInfo : TrackInfo[] = [];
        this.streams.forEach((stream) => {
            return stream.getTracks().forEach((track) => {
                tracksInfo.push({
                    streamID: stream.id,
                    id: track.id,
                    kind: track.kind,
                    label: track.label,
                    enabled: track.enabled,
                    readyState: track.readyState,
                });
            });
        });

        const stats = await this.peer.getStats();

        return {
            initTime: this.initTime,
            callID: this.channelID,
            tracksInfo,
            rtcStats: stats ? parseRTCStats(stats) : null,
        };
    }

    public getAudioDevices() {
        return this.audioDevices;
    }

    public getSessionID() {
        return this.ws?.getOriginalConnID();
    }
}
