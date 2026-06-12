import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// 获取用户列表
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '20');
    const keyword = searchParams.get('keyword') || '';
    const role = searchParams.get('role') || '';
    const status = searchParams.get('status') || '';

    const client = getDb();

    // 查询所有用户（select * 然后过滤掉密码）
    let query = client.from('users').select('*', { count: 'exact' });

    if (role) {
      query = query.eq('role', role);
    }
    if (status) {
      query = query.eq('status', status);
    }

    const offset = (page - 1) * pageSize;
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (error) {
      return NextResponse.json({ success: false, error: '查询失败' }, { status: 500 });
    }

    // 过滤关键字
    let items = data || [];
    if (keyword) {
      items = items.filter((u: any) =>
        u.username?.toLowerCase().includes(keyword.toLowerCase()) ||
        u.nickname?.toLowerCase().includes(keyword.toLowerCase()) ||
        u.email?.toLowerCase().includes(keyword.toLowerCase())
      );
    }

    // 移除密码字段
    items = items.map((u: any) => {
      const { password, ...userWithoutPassword } = u;
      return userWithoutPassword;
    });

    return NextResponse.json({
      success: true,
      data: {
        items,
        total: count || 0,
        page,
        pageSize,
      },
    });
  } catch (error) {
    console.error('获取用户列表失败:', error);
    return NextResponse.json({ success: false, error: '获取用户列表失败' }, { status: 500 });
  }
}

// 创建用户
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { username, password, nickname, email, phone, role, department, description } = body;

    if (!username || !password) {
      return NextResponse.json(
        { success: false, error: '用户名和密码不能为空' },
        { status: 400 }
      );
    }

    if (username.length < 3 || username.length > 50) {
      return NextResponse.json(
        { success: false, error: '用户名长度应在3-50个字符之间' },
        { status: 400 }
      );
    }

    if (password.length < 6) {
      return NextResponse.json(
        { success: false, error: '密码长度至少6个字符' },
        { status: 400 }
      );
    }

    const client = getDb();

    // 检查用户名是否已存在
    const { data: existing } = await client
      .from('users')
      .select('id')
      .eq('username', username)
      .limit(1);

    if (existing && existing.length > 0) {
      return NextResponse.json(
        { success: false, error: '用户名已存在' },
        { status: 400 }
      );
    }

    // 检查邮箱是否已存在
    if (email) {
      const { data: existingEmail } = await client
        .from('users')
        .select('id')
        .eq('email', email)
        .limit(1);

      if (existingEmail && existingEmail.length > 0) {
        return NextResponse.json(
          { success: false, error: '邮箱已被使用' },
          { status: 400 }
        );
      }
    }

    // 创建用户（生产环境应使用 bcrypt 加密密码）
    const { data, error } = await client
      .from('users')
      .insert({
        username,
        password, // TODO: 使用 bcrypt 加密
        nickname: nickname || username,
        email,
        phone,
        role: role || 'user',
        department,
        description,
      })
      .select()
      .single();

    if (error) {
      console.error('创建用户失败:', error);
      return NextResponse.json({ success: false, error: '创建用户失败' }, { status: 500 });
    }

    // 返回用户信息（不包含密码）
    const { password: _, ...userWithoutPassword } = data;

    return NextResponse.json({
      success: true,
      data: userWithoutPassword,
    });
  } catch (error) {
    console.error('创建用户失败:', error);
    return NextResponse.json({ success: false, error: '创建用户失败' }, { status: 500 });
  }
}

// 更新用户
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, nickname, email, phone, role, status, department, description, password } = body;

    if (!id) {
      return NextResponse.json(
        { success: false, error: '用户ID不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    // 检查用户是否存在
    const { data: existing } = await client
      .from('users')
      .select()
      .eq('id', id)
      .single();

    if (!existing) {
      return NextResponse.json(
        { success: false, error: '用户不存在' },
        { status: 404 }
      );
    }

    // 构建更新数据
    const updateData: any = { updated_at: new Date().toISOString() };
    if (nickname !== undefined) updateData.nickname = nickname;
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone = phone;
    if (role !== undefined) updateData.role = role;
    if (status !== undefined) updateData.status = status;
    if (department !== undefined) updateData.department = department;
    if (description !== undefined) updateData.description = description;
    if (password) {
      if (password.length < 6) {
        return NextResponse.json(
          { success: false, error: '密码长度至少6个字符' },
          { status: 400 }
        );
      }
      updateData.password = password; // TODO: 使用 bcrypt 加密
      updateData.password_changed_at = new Date().toISOString();
    }

    const { data, error } = await client
      .from('users')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('更新用户失败:', error);
      return NextResponse.json({ success: false, error: '更新用户失败' }, { status: 500 });
    }

    // 返回用户信息（不包含密码）
    const { password: _, ...userWithoutPassword } = data;

    return NextResponse.json({
      success: true,
      data: userWithoutPassword,
    });
  } catch (error) {
    console.error('更新用户失败:', error);
    return NextResponse.json({ success: false, error: '更新用户失败' }, { status: 500 });
  }
}

// 删除用户
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { success: false, error: '用户ID不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    // 检查用户是否存在
    const { data: existing } = await client
      .from('users')
      .select()
      .eq('id', id)
      .single();

    if (!existing) {
      return NextResponse.json(
        { success: false, error: '用户不存在' },
        { status: 404 }
      );
    }

    // 不允许删除默认管理员
    if (existing.username === 'admin') {
      return NextResponse.json(
        { success: false, error: '不能删除默认管理员账号' },
        { status: 400 }
      );
    }

    const { error } = await client
      .from('users')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('删除用户失败:', error);
      return NextResponse.json({ success: false, error: '删除用户失败' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('删除用户失败:', error);
    return NextResponse.json({ success: false, error: '删除用户失败' }, { status: 500 });
  }
}
