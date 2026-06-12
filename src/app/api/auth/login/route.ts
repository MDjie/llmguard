import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { sign } from 'jsonwebtoken';
import bcrypt from 'bcrypt';

const JWT_SECRET = process.env.JWT_SECRET || 'guardllm-secret-key-2024';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { username, password, rememberMe } = body;

    if (!username || !password) {
      return NextResponse.json(
        { success: false, error: '用户名和密码不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    // 查询用户
    const { data: users, error } = await client
      .from('users')
      .select()
      .eq('username', username)
      .limit(1);

    if (error) {
      console.error('查询用户失败:', error);
      return NextResponse.json(
        { success: false, error: '登录失败，请稍后重试' },
        { status: 500 }
      );
    }

    if (!users || users.length === 0) {
      return NextResponse.json(
        { success: false, error: '用户名或密码错误' },
        { status: 401 }
      );
    }

    const user = users[0];

    // 检查账号状态
    if (user.status === 'disabled') {
      return NextResponse.json(
        { success: false, error: '账号已被禁用，请联系管理员' },
        { status: 403 }
      );
    }

    if (user.status === 'locked') {
      return NextResponse.json(
        { success: false, error: '账号已被锁定，请联系管理员' },
        { status: 403 }
      );
    }

    // 验证密码（使用 bcrypt）
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      // 更新失败登录次数
      await client
        .from('users')
        .update({ failed_login_count: (user.failed_login_count || 0) + 1 })
        .eq('id', user.id);

      return NextResponse.json(
        { success: false, error: '用户名或密码错误' },
        { status: 401 }
      );
    }

    // 生成 JWT token
    const token = sign(
      { userId: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: rememberMe ? '7d' : '24h' }
    );

    // 更新登录信息
    await client
      .from('users')
      .update({
        last_login_at: new Date().toISOString(),
        login_count: (user.login_count || 0) + 1,
        failed_login_count: 0,
      })
      .eq('id', user.id);

    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        email: user.email,
        avatar: user.avatar,
        role: user.role,
      },
    });

    response.cookies.set('auth-token', token, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: rememberMe ? 7 * 24 * 60 * 60 : 24 * 60 * 60,
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('登录错误:', error);
    return NextResponse.json(
      { success: false, error: '登录失败，请稍后重试' },
      { status: 500 }
    );
  }
}
