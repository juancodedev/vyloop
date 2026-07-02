export default {
  fetch(): Response {
    return new Response(
      JSON.stringify({ service: 'analytics', status: 'placeholder' }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  },
};
