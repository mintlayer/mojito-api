import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IpfsService, safeContentType } from './ipfs.service';

/**
 * GET /ipfs/:cid — same-origin-style IPFS proxy for token metadata and
 * icons, shared by the browser extension, the mobile wallet and web
 * clients. Served with `Access-Control-Allow-Origin: *` because the
 * browser extension pages are a different origin (unlike the bridge's
 * same-origin deployment). Responses are hardened exactly like the
 * bridge's: allowlisted content types, `sandbox` CSP, nosniff, immutable
 * cache headers, byte cap.
 */
@ApiTags('IPFS')
@Controller('ipfs')
export class IpfsController {
  constructor(private readonly ipfs: IpfsService) {}

  @Get(':cid')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fetch and cache IPFS content by CID' })
  async get(@Param('cid') cid: string, @Res() res: Response) {
    const result = await this.ipfs.resolve(cid);

    if (result.status !== 200) {
      res
        .status(result.status)
        .set({
          'X-Content-Type-Options': 'nosniff',
          'Access-Control-Allow-Origin': '*',
          // A failed gateway walk is repeatable at request rate — cache the
          // failure briefly (mirrors the bridge's negative cache headers).
          'Cache-Control': 'public, max-age=60',
        })
        .type('text/plain')
        .send(result.error);
      return;
    }

    const headers: Record<string, string> = {
      'X-Content-Type-Options': 'nosniff',
      // Even a slipped-through HTML payload runs in an opaque origin with
      // no script, form, or same-origin access.
      'Content-Security-Policy': 'sandbox',
      // IPFS content is content-addressed — safe to cache aggressively.
      'Cache-Control': 'public, max-age=2592000, immutable',
      'X-IPFS-Gateway': result.source,
      'Access-Control-Allow-Origin': '*',
    };
    if (!result.contentType.startsWith('image/')) {
      headers['Content-Disposition'] = `attachment; filename="${cid}"`;
    }

    res
      .status(HttpStatus.OK)
      .set(headers)
      .type(safeContentType(result.contentType))
      .send(result.body);
  }
}
