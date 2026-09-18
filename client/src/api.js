export const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('token') || ''}` });

export async function api(path, options = {}) {
  try {
    const response = await fetch(path, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    const body = await response.json();
    if (!response.ok || !body.success) {
      if (response.status === 401) window.dispatchEvent(new Event('canteen:unauthorized'));
      throw new Error(body.error || 'Request failed');
    }
    return body.data;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('The server returned an invalid response');
    throw error;
  }
}

export const currency = value => `₹${Number(value || 0).toFixed(2)}`;
export const time = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
