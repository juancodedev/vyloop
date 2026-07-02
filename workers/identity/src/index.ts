export default {
  fetch(): Response {
    return new Response(
      JSON.stringify({ service: 'identity', status: 'placeholder' }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  },
};
