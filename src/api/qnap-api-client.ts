import axios, { AxiosInstance } from 'axios';
import https from 'https';
import { parseString } from 'xml2js';
import { XMLParser } from 'fast-xml-parser';
import { networkInterfaces } from 'os';

const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
});

export class QnapApiClient {
    public readonly url: string;
    private readonly qts: AxiosInstance;
    private readonly client: AxiosInstance;
    private sid: string;

    constructor(url: string) {
        this.url = url;
        this.client = axios.create({
            baseURL: url,
            timeout: 10000,
            httpsAgent,
        });
    }

    public async login(user: string, password: string): Promise<boolean> {
        const params = {
            user: user,
            pwd: Buffer.from(password, 'utf-8').toString('base64'),
            service: 1
        };

        const response = await this.sendRequest<any>(params, '/cgi-bin/authLogin.cgi');
        if (response.authPassed) {
            this.sid = response.authSid;
            return true;
        } else {
            throw new Error(`auth failed`);
        }

        return false;
    }

    public async getCameraSnapshot(cameraId: any) {
        const params = {
            'x-apima-key': '\@APIMA_KEY\@',
            qsauth_type: 0,
            qsauth_token: this.sid,
            cache_img: 'no',
            default_img: 'no',
            guid: cameraId,
            sid: this.sid
        };

        const response = await this.client.get<ArrayBuffer>('/qvrpro/apis/getliveimage.cgi', { params, responseType: 'arraybuffer' });
        
        return response.data;
    }

    public async listCameras(): Promise<QnapCamera[]> {
        const params = {
            'x-apima-key': '\@APIMA_KEY\@',
            act: 'get_all_status',
            sid: this.sid
        };
        const response = await this.sendRequest<any>(params, '/qvrpro/apis/camera_status.cgi');

        if ( response.success ){
            return response.datas
        } else {
            throw new Error(`failed to get camers.`);
        }
    }

    public async getRTSPShareInfo(guid: string): Promise<RTSPInfo> {
        const params = {
            'x-apima-key': '\@APIMA_KEY\@',
            act: 'show_share_status',
            sid: this.sid,
            guid: guid
        };
        const response = await this.sendRequest<any>(params, '/qvrpro/apis/rtsp_sharelink_settings.cgi');

        if ( response.success ){
            return response
        } else {
            throw new Error(`get rtsp info failed.`);
        }
    }

    private async sendRequest<T>(params: any, url: string): Promise<T> {
        const response = await this.client.get<any>(url, { params });
        if ( url.indexOf('authLogin') > 0 ){
            const parser = new XMLParser()
            return parser.parse(response.data).QDocRoot;
        } else {
            return response.data;
        }
    }
}

export interface QnapCamera {
    id:string,
    channel_index: number,
    name: string,
    umsid: string,
    guid: string,
    brand: string,
    model: string,
    stream_state: QnapCameraStream[],
    video_codec_setting: string,
    frame_rate_setting: string,
    rtsp_sharelink_enabled: number
}

export interface QnapCameraStream {
    id: string;
    stream: string;
    frame_rate?: number;
    video_resolution_setting: string;
    bit_rate?: number;
    video_quality_setting?: string;
}

export interface rtspNetwork {
    host_ip: string,
    port: number
}

export interface RTSPInfo {
    path: string,
    stream_id: number,
    network_domains: rtspNetwork
}