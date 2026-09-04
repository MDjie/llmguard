import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { experimentalLabsEnabled } from '@/lib/product-features';

/**
 * Keep internal lab routes outside the production HTTP surface. Route-level
 * guards remain in place as defense in depth, while this boundary guarantees
 * a real 404 response before rendering or API handling begins.
 */
export function proxy(request: NextRequest): NextResponse {
  if (experimentalLabsEnabled()) {
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, error: 'Not found' },
      {
        status: 404,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  return new NextResponse('Not found', {
    status: 404,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Robots-Tag': 'noindex',
    },
  });
}

export const config = {
  matcher: [
    '/simulate/:path*',
    '/model-eval/:path*',
    '/api/simulate/:path*',
  ],
};
