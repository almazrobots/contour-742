"""Synthetic regressions from blind first-five visual diagnostics, no corpus payload."""
import pytest

from inspector_ml.class_mentions import extract_class_mentions
from test_class_mentions import mk_doc
from test_class_scales import spec
from test_count_mentions import found
pytestmark = [pytest.mark.l1_functional, pytest.mark.l6_adversarial]


def specification(code):
    # Shared test fixture models the API passport configuration, without
    # importing the private-corpus replay/export command.
    return spec(code), None


@pytest.mark.parametrize('code', ['M-021', 'M-124'])
@pytest.mark.parametrize('value', ['C-', 'С−', 'C+', 'B+'])
def test_other_energy_scale_token_is_preserved_not_truncated(code, value):
    values = extract_class_mentions(mk_doc([f'Класс энергоэффективности {value}.']), spec(code))
    assert len(values) == 1
    assert values[0].meta['excluded'] == 'ALT_SYSTEM'
    assert values[0].value_text == value
    assert values[0].bbox


@pytest.mark.parametrize('code', ['M-021', 'M-124'])
@pytest.mark.parametrize('verb', ['определен', 'установлен', 'присвоен', 'определён и установлен'])
def test_conditional_future_energy_class_is_not_an_established_class(code, verb):
    doc = mk_doc([f'После подтверждения расхода может быть {verb} класс энергоэффективности B.'])
    found = extract_class_mentions(doc, spec(code))
    assert len(found) == 1
    assert found[0].value_text == 'B'
    assert found[0].meta['excluded'] == 'CONDITIONAL_CLASS'
    assert found[0].bbox and found[0].meta['quote']


@pytest.mark.parametrize('code', ['M-021', 'M-124'])
@pytest.mark.parametrize('text', [
    'Проектом установлен класс энергоэффективности B.',
    'Зданию присваивается класс энергетической эффективности B.',
    'Впоследствии может быть установлен прибор учета. Класс энергоэффективности B.',
])
def test_declared_project_energy_class_remains_eligible(code, text):
    found = extract_class_mentions(mk_doc([text]), spec(code))
    assert len(found) == 1
    assert found[0].meta['excluded'] is None


def test_floor_range_plus_basement_does_not_become_one_floor():
    result = found('M-007', 'Количество этажей 18-22 +1 подземный этаж')
    assert not [value for value, excluded in result if excluded is None]


def test_maximum_height_does_not_exclude_declared_floor_count():
    result = found('M-007', 'Здание трехэтажное с максимальной высотой 14 м.')
    assert (3.0, None) in result


def test_general_construction_permission_is_not_project_fire_class():
    parameter, _ = specification('M-023')
    text = 'Конструкции могут использоваться в зданиях с классом конструктивной пожарной опасности С0.'
    values = extract_class_mentions(mk_doc([text]), parameter)
    assert len(values) == 1
    assert values[0].meta['excluded'] == 'NORM_STATEMENT'
    # The next explicit project declaration is not excluded by that permission.
    values = extract_class_mentions(mk_doc([text + ' Проектируемое здание имеет класс конструктивной пожарной опасности С1.']), parameter)
    assert any(v.value_text == 'С1' and v.meta['excluded'] is None for v in values)


def test_reverse_construction_class_label_does_not_borrow_previous_sentence():
    parameter, _ = specification('M-023')
    values = extract_class_mentions(mk_doc(['С0 — класс конструктивной пожарной опасности.']), parameter)
    assert len(values) == 1 and values[0].value_text == 'С0'
    assert values[0].meta['excluded'] is None
    assert extract_class_mentions(mk_doc(['У соседнего здания С1. Класс конструктивной пожарной опасности не указан.']), parameter) == []


def test_reverse_class_labels_keep_their_own_values_and_full_norm_sentence():
    parameter, _ = specification('M-023')
    text = ('Проектом предусмотрен С1 класс конструктивной пожарной опасности. '
            'Правила, устанавливающие максимально допустимую площадь этажа '
            'для помещений подземной автостоянки при размещении технических помещений, '
            'предусматривают С0 класс конструктивной пожарной опасности.')
    values = extract_class_mentions(mk_doc([text]), parameter)
    assert [(v.value_text, v.meta['excluded']) for v in values] == [('С1', None), ('С0', 'NORM_STATEMENT')]


def test_margin_number_marker_inside_wrapped_class_label():
    parameter, _ = specification('M-023')
    values = extract_class_mentions(mk_doc(['Проектом принят С0 класс конструктивной',
                                            '№ пожарной опасности.']), parameter)
    assert len(values) == 1 and values[0].value_text == 'С0'
    assert values[0].bbox and values[0].meta['excluded'] is None


def test_construction_requirement_does_not_replace_declared_building_class():
    parameter, _ = specification('M-023')
    text = ('Для проектируемого здания принят класс конструктивной пожарной опасности С1. '
            'Классы конструкций приняты не ниже нормируемых для зданий С0 класса '
            'конструктивной пожарной опасности.')
    values = extract_class_mentions(mk_doc([text]), parameter)
    assert [(v.value_text, v.meta['excluded']) for v in values] == [('С1', None), ('С0', 'NORM_STATEMENT')]


def test_ramp_class_is_not_whole_building_class():
    parameter, _ = specification('M-023')
    values = extract_class_mentions(mk_doc(['Стены рампы С0 класса конструктивной пожарной опасности. '
        'Проектируемое жилое здание С1 класса конструктивной пожарной опасности.']), parameter)
    assert [(v.value_text, v.meta['excluded']) for v in values] == [('С0', 'SUBOBJECT'), ('С1', None)]
    assert values[0].meta['subject_key'] == 'subobject:ramp'


def test_joint_building_and_ramp_class_keeps_building_evidence():
    parameter, _ = specification('M-023')
    text = ('Расстояние от проектируемого жилого здания и надземной части '
            'изолированной рампы встроенной подземной автостоянки II степени '
            'огнестойкости, С0 класса конструктивной пожарной опасности до '
            'существующего здания составляет не менее 15 м.')
    values = extract_class_mentions(mk_doc([text]), parameter)
    assert len(values) == 1
    assert values[0].meta['excluded'] is None
    assert values[0].meta['subject_key'] == 'object_and_ramp'
    stamped = text.replace('изолированной рампы', 'изолированной Взам. рампы')
    stamped_values = extract_class_mentions(mk_doc([stamped]), parameter)
    assert stamped_values[0].meta['excluded'] is None
    assert stamped_values[0].meta['subject_key'] == 'object_and_ramp'
    assert stamped_values[0].bbox is not None
    separate = ('Проектируемое жилое здание С1 класса конструктивной пожарной опасности '
                'и стены рампы С0 класса конструктивной пожарной опасности.')
    values = extract_class_mentions(mk_doc([separate]), parameter)
    assert [(v.value_text, v.meta['excluded']) for v in values] == [('С1', None), ('С0', 'SUBOBJECT')]


def test_empty_class_anchor_cannot_steal_next_list_item_value():
    parameter, _ = specification('M-023')
    text = ('Вне зависимости от класса конструктивной пожарной опасности составляет 15 м; '
            'расстояние от рампы С0 класса конструктивной пожарной опасности составляет 10 м.')
    values = extract_class_mentions(mk_doc([text]), parameter)
    assert len(values) == 1
    assert values[0].meta['excluded'] == 'SUBOBJECT'


def test_distance_target_transformer_is_not_project_building():
    parameter, _ = specification('M-023')
    text = ('Расстояние от проектируемого здания С1 класса конструктивной пожарной опасности '
            'до площадки под размещение трансформаторной подстанции IV степени огнестойкости, '
            'С0 класса конструктивной пожарной опасности составляет 12 м.')
    values = extract_class_mentions(mk_doc([text]), parameter)
    assert [(v.value_text, v.meta['excluded']) for v in values] == [('С1', None), ('С0', 'NEIGHBOR')]
    own = extract_class_mentions(mk_doc(['Проектируемая трансформаторная подстанция IV степени '
        'огнестойкости, С0 класса конструктивной пожарной опасности.']), parameter)
    assert own[0].meta['excluded'] is None


@pytest.mark.parametrize('code', ['M-021', 'M-124'])
def test_normal_c_under_sp50_is_not_399_class_c(code):
    parameter, _ = specification(code)
    text = 'Расчет по СП 50.13330.2012. Класс энергетической эффективности C (нормальный).'
    values = extract_class_mentions(mk_doc([text]), parameter)
    assert values[0].value_text == 'C'
    assert values[0].meta['excluded'] == 'ALT_SYSTEM'
    # A thermal reference alone must not reclassify the declared energy class.
    values = extract_class_mentions(mk_doc([text.replace('нормальный', 'повышенный')]), parameter)
    assert values[0].meta['excluded'] is None


def test_explicit_building_degree_after_compartment_description():
    parameter, _ = specification('M-022')
    values = extract_class_mentions(mk_doc([
        'Здание разделено на 3 пожарных отсека:',
        '1, 2 пожарный отсек - подземная часть здания',
        '3 пожарный отсек - надземная часть здания',
        '- Степень огнестойкости здания - I, согласно требованиям.',
    ]), parameter)
    assert len(values) == 1
    assert values[0].value_text == 'I'
    assert values[0].meta['excluded'] is None
    assert values[0].meta['subject_key'] is None
