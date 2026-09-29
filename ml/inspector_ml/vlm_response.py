"""A completed HTTP request does not imply a complete model transcription."""


def completed_text(response: dict) -> str:
    choices = response.get('choices') if isinstance(response, dict) else None
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
        raise RuntimeError('invalid VLM choices')
    choice = choices[0]
    if choice.get('finish_reason') != 'stop':
        # Do not log the model content or accept an apparently valid JSON prefix.
        raise RuntimeError('incomplete VLM generation')
    message = choice.get('message')
    if not isinstance(message, dict) or not isinstance(message.get('content'), str) or message.get('tool_calls'):
        raise RuntimeError('invalid completed VLM response')
    return message['content'].strip()
