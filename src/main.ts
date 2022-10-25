import sdk, { Camera, Device, DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, MediaObject, MediaStreamOptions, MediaStreamUrl, MotionSensor, PictureOptions, ResponseMediaStreamOptions, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, VideoCamera } from "@scrypted/sdk";
import { createInstanceableProviderPlugin, enableInstanceableProviderMode, isInstanceableProviderModeEnabled } from '../../../common/src/provider-plugin';
import { QnapApiClient, QnapCamera, QnapCameraStream } from "./api/qnap-api-client";

const { deviceManager } = sdk;

class QnapCameraDevice extends ScryptedDeviceBase implements Camera, HttpRequestHandler, MotionSensor, Settings, VideoCamera {
    private provider: QnapNvrPro;
    private streams: QnapCameraStream[];

    constructor(provider: QnapNvrPro, nativeId: string, camera: QnapCamera) {
        super(nativeId);
        this.provider = provider;
        this.streams = QnapCameraDevice.identifyStreams(camera);
    }

    public async getSettings(): Promise<Setting[]> {
        const vsos = await this.getVideoStreamOptions();

        return [];
    }

    public async putSetting(key: string, value: string | number | boolean) {
        this.storage.setItem(key, value?.toString());
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }

    private async getSnapshot(options?: PictureOptions): Promise<Buffer> {
        const data = await this.provider.api.getCameraSnapshot(this.nativeId);

        return Buffer.from(data);
    }

    public async takePicture(options?: PictureOptions): Promise<MediaObject> {
        const buffer = await this.getSnapshot(options);
        return this.createMediaObject(buffer, 'image/jpeg');
    }

    async getVideoStream(options?: MediaStreamOptions): Promise<MediaObject> {
        const vsos = await this.getVideoStreamOptions();
        const vso = vsos.find(check => check.id === options?.id) || vsos[0];

        const rtspChannel = this.streams.find(check => check.id === vso.id);
        const username = this.provider.getSetting('username');
        const password = this.provider.getSetting('password');
        const info = await this.provider.api.getRTSPShareInfo(this.nativeId);
        
        const data = Buffer.from(JSON.stringify({
            url: `rtsp://${username}:${password}@${info.network_domains.host_ip}:${info.network_domains.port}${info.path}`,
            container: 'rtsp',
            mediaStreamOptions: this.createMediaStreamOptions(rtspChannel),
        } as MediaStreamUrl));
        return this.createMediaObject(data, ScryptedMimeTypes.MediaStreamUrl);
    }

    public async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        const vsos = this.streams.map(channel => this.createMediaStreamOptions(channel));
        return vsos;
    }

    private createMediaStreamOptions(stream: QnapCameraStream) {
        const ret: ResponseMediaStreamOptions = {
            id: stream.id,
            name: stream.id,
            container: 'rtsp',
            video: {
                codec: 'h264',
                width: parseInt(stream.video_resolution_setting.substring(0, stream.video_resolution_setting.indexOf('x'))),
                height: parseInt(stream.video_resolution_setting.substring(stream.video_resolution_setting.indexOf('x') + 1)),
                fps: stream.frame_rate
            },
            audio: {
                codec: 'aac',
            },
        };
        this.console.log(ret);
        return ret;
    }

    public async getPictureOptions(): Promise<PictureOptions[]> {
        return;
    }

    public async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        this.console.log(request);
        this.console.log(response);
    }

    private static identifyStreams(camera: QnapCamera): QnapCameraStream[] {
        return [
            { ...camera.stream_state[0], id: '1' },
            { ...camera.stream_state[1], id: '2' },
            { ...camera.stream_state[2], id: '3' },
        ].filter(s => !!s.bit_rate);
    }
}

class QnapNvrPro extends ScryptedDeviceBase implements Settings, DeviceProvider {
    api: QnapApiClient;
    private cameras: QnapCamera[];
    private cameraDevices: Map<string, QnapCameraDevice> = new Map();
    private startup: Promise<void>;

    constructor(nativeId?: string) {
        super(nativeId);

        this.startup = this.discoverDevices(0);
    }

    public async discoverDevices(duration: number): Promise<void> {
        const url = this.getSetting('url');
        const username = this.getSetting('username');
        const password = this.getSetting('password');

        this.log.clearAlerts();

        if (!url) {
            this.log.a('Must provide URL.');
            return
        }

        if (!username) {
            this.log.a('Must provide username.');
            return
        }

        if (!password) {
            this.log.a('Must provide password.');
            return
        }

        if (!this.api || url !== this.api.url) {
            this.api = new QnapApiClient(url);
        }

        try {
            const loginStatus = await this.api.login(username, password);
        }
        catch (e) {
            this.log.a(`login error: ${e}`);
            this.console.error('login error', e);
            return;
        }
        
        try {
            this.cameras = await this.api.listCameras();
            
            if (!this.cameras) {
                this.console.error('Cameras failed to load. Retrying in 10 seconds.');
                setTimeout(() => {
                    this.discoverDevices(0);
                }, 100000);
                return;
            }
        }catch (e) {
            this.log.a(`device discovery error: ${e}`);
            this.console.error('device discovery error', e);
        }

        this.console.info(`Discovered ${this.cameras.length} camera(s)`);
        
        const devices: Device[] = [];
        for (let camera of this.cameras) {
            if (camera.rtsp_sharelink_enabled) {
                const d: Device = {
                    providerNativeId: this.nativeId,
                    name: camera.name,
                    nativeId: '' + camera.guid,
                    info: {
                        manufacturer: camera.brand,
                        model: camera.model,
                        serialNumber: `Camera-${camera.guid}`,
                    },
                    interfaces: [
                        ScryptedInterface.Camera,
                        ScryptedInterface.HttpRequestHandler,
                        ScryptedInterface.MotionSensor,
                        ScryptedInterface.Settings,
                        ScryptedInterface.VideoCamera,
                    ],
                    type: ScryptedDeviceType.Camera
                };
    
                devices.push(d);
            }
        }

        for (const d of devices) {
            await deviceManager.onDeviceDiscovered(d);
        }

        for (const device of devices) {
            this.getDevice(device.nativeId);
        }
    }

    async getDevice(nativeId: string): Promise<any> {
        await this.startup;
        if (this.cameraDevices.has(nativeId))
            return this.cameraDevices.get(nativeId);
        const camera = this.cameras.find(camera => ('' + camera.guid) === nativeId);
        if (!camera)
            throw new Error('camera not found?');
        const ret = new QnapCameraDevice(this, nativeId, camera);
        this.cameraDevices.set(nativeId, ret);
        return ret;
    }


    getSetting(key: string): any {
        return this.storage.getItem(key);
    }

    async getSettings(): Promise<Setting[]> {
        const ret: Setting[] = [
            {
                key: 'username',
                title: 'Username',
                value: this.getSetting('username'),
            },
            {
                key: 'password',
                title: 'Password',
                type: 'password',
                value: this.getSetting('password'),
            },
            {
                key: 'url',
                title: 'QNAP QVR Pro URL',
                placeholder: 'http://192.168.48.55:8080',
                value: this.getSetting('url'),
            },
        ];

        return ret;
    }

    async putSetting(key: string, value: string | number) {
        this.storage.setItem(key, value.toString());
        this.discoverDevices(0);
    }
}

export default createInstanceableProviderPlugin("Synology Surveillance Station NVR", nativeid => new QnapNvrPro(nativeid));